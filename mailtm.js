// Mail.TM Client -- khong can API key, domain it bi FB blacklist hon
// Interface tuong thich voi TempMailAPI: createEmail(), pollForOtp()
const https = require('https')

function sleep(ms) { return new Promise(function(r){setTimeout(r,ms)}) }
function randStr(n) {
  // Bat dau bang chu thuong, tiep theo la chu + so
  const letters='abcdefghijklmnopqrstuvwxyz'
  const all='abcdefghijklmnopqrstuvwxyz0123456789'
  let s=letters[Math.floor(Math.random()*letters.length)]
  for(let i=1;i<(n||10);i++) s+=all[Math.floor(Math.random()*all.length)]
  return s
}

function httpReq(url, opts, body) {
  opts = opts||{}
  return new Promise(function(resolve,reject){
    const u = new URL(url)
    const rawBody = body ? JSON.stringify(body) : null
    const headers = Object.assign(
      {'Content-Type':'application/json','Accept':'application/json','User-Agent':'Mozilla/5.0'},
      opts.headers||{}
    )
    if(rawBody) headers['Content-Length'] = Buffer.byteLength(rawBody)
    const o = { hostname:u.hostname, path:u.pathname+(u.search||''), method:opts.method||'GET',
      headers:headers, timeout:opts.timeout||20000 }
    const req = https.request(o, function(res){
      let raw=''
      res.setEncoding('utf8')
      res.on('data',function(c){raw+=c})
      res.on('end',function(){ try{resolve({s:res.statusCode,d:JSON.parse(raw)})}catch(e){resolve({s:res.statusCode,d:raw})} })
    })
    req.on('timeout',function(){req.destroy(new Error('Timeout mail.tm'))})
    req.on('error',reject)
    if(rawBody) req.write(rawBody)
    req.end()
  })
}

class MailTm {
  constructor(){ this.base='https://api.mail.tm'; this._d=null; this._t=0 }

  async getDomains(){
    if(this._d && Date.now()-this._t<600000) return this._d
    try{
      const r = await httpReq(this.base+'/domains?page=1')
      // API co the tra array truc tiep hoac hydra:Collection
      let list = r.d
      if(!Array.isArray(list)) list = (list&&list['hydra:member'])||[]
      const active = list.filter(function(d){return d.isActive&&!d.isPrivate}).map(function(d){return d.domain})
      if(active.length>0){ this._d=active; this._t=Date.now(); return active }
    }catch(e){}
    return ['maxxspace.com']
  }

  async createEmail(pref){
    const domains = await this.getDomains()
    const domain = (pref&&domains.includes(pref)) ? pref : domains[Math.floor(Math.random()*domains.length)]
    let lastErr = null
    for(let t=1;t<=3;t++){
      try{
        // Local-part: chi chu thuong + so, bat dau bang chu (khong dau cham o dau/cuoi)
        const address = randStr(7)+randStr(4)+'@'+domain
        const password = randStr(12)+'Bb2!'
        const r1 = await httpReq(this.base+'/accounts',{method:'POST'},{address:address,password:password})
        if(r1.s===201||r1.s===200){
          const r2 = await httpReq(this.base+'/token',{method:'POST'},{address:address,password:password})
          if(r2.s===200&&r2.d&&r2.d.token) return {email:address,sidToken:r2.d.token}
          throw new Error('Khong lay duoc JWT token (HTTP '+r2.s+')')
        }
        const m=(r1.d&&(r1.d['hydra:description']||r1.d.message))||'HTTP '+r1.s
        lastErr = new Error('mail.tm createEmail: '+m)
        if(t<3) await sleep(3000)
      }catch(e){ lastErr=e; if(t<3) await sleep(3000); }
    }
    throw lastErr
  }

  async getEmailList(jwt){
    const r = await httpReq(this.base+'/messages?page=1',{headers:{Authorization:'Bearer '+jwt}})
    if(r.s!==200) return []
    if(Array.isArray(r.d)) return r.d
    return (r.d&&r.d['hydra:member'])||[]
  }

  async fetchEmail(jwt,id){
    const r = await httpReq(this.base+'/messages/'+id,{headers:{Authorization:'Bearer '+jwt}})
    return r.s===200 ? r.d : null
  }

  extractOtp(subject,body,len){
    subject=subject||''; body=body||''; len=len||5
    const t=(subject+' '+body.replace(/<[^>]+>/g,' ')).replace(/\s+/g,' ')
    // Tim gan tu khoa xac thuc
    const m1=t.match(new RegExp('(?:code|ma|confirm|verify|facebook)[^\\d]{0,40}(\\d{'+len+'})(?!\\d)','i'))
    if(m1) return m1[1]
    // Tim trong subject
    const m2=subject.match(new RegExp('(?<!\\d)(\\d{'+len+'})(?!\\d)'))
    if(m2) return m2[1]
    // Fallback
    const m3=t.match(new RegExp('(?<!\\d)(\\d{'+len+'})(?!\\d)'))
    return m3?m3[1]:null
  }

  async pollForOtp(jwt, seen, max, interval, log){
    seen=seen||new Set(); max=max||25; interval=interval||6000; log=log||function(){}
    for(let i=1;i<=max;i++){
      log('[mail.tm] Cho OTP lan '+i+'/'+max+'...')
      try{
        const msgs = await this.getEmailList(jwt)
        const news = msgs.filter(function(m){return !seen.has(m.id)})
        if(news.length>0){
          const msg=news[0]
          log('[mail.tm] Email moi: '+msg.subject)
          let body=msg.text||msg.intro||''
          try{ const full=await this.fetchEmail(jwt,msg.id); if(full) body=full.text||full.html||full.intro||body }catch(e){}
          const otp=this.extractOtp(msg.subject||'',body)
          if(otp){ log('[mail.tm] OTP: '+otp); return {otp:otp,subject:msg.subject,mailId:msg.id} }
          seen.add(msg.id)
        }
      }catch(err){ log('[mail.tm] Loi: '+err.message) }
      if(i<max) await sleep(interval)
    }
    return null
  }
}

module.exports = MailTm