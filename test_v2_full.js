// Test FULL v2 flow với cookie Gmail user cung cấp — chạy đúng production flow
const { app } = require('electron')
const FBRegisterEngine = require('./fbreg.js')
const fs = require('fs')

const jar = JSON.parse(fs.readFileSync('C:/Users/Admin/Downloads/Telegram Desktop/mail 3.txt', 'utf8'))
const gmailCookie = "SAPISID=7whsbqWiuTxp8gwA/ApzfH4xDxiL4Eflsb; __Secure-3PAPISID=7whsbqWiuTxp8gwA/ApzfH4xDxiL4Eflsb; AEC=Aaa9EJqHhBcvrqdRL8yybKGILrwcXzAZa8QlUJE9E2VOZepBnKj682dalek; GMAIL_AT=AF6bupOlOj1O6tHCRcJ1uVjYBQKJxfu8xQ; NID=CvACCAESogIBOxGDSHnWPB-TX-WpdeLknQCnZFtYCGMhsEP_2Wkg5-rhHl6MzfYTLl7yC9Hsuo2GY3irTgZRenqenw5O9tW57sNkKUeUdHpo7iLRRY663cW9YiMw_r_dow8S9lvjsm1qkVxJJPSnFyG16VdIPJrR_GD_i5nA0ATOpZ0w8-y1NssncJz0_RS9FnjbM4efswChXpqrmaqCHbbMUR62-rxiqiVRYibU0BRFeKjTeaviuXwh6_xIzkrGwtsbfWlTBsqWitb5fhkg-Ho4z3FMvDt4Lg8RRfVAPiXlaQODvNiMV2lUFbVh8aId5RWRmOOwzcVg36PvFYJTiGAfQHolMDMMpcfEPmZzw0dWwwQUNc1b-9OJZIFWXnDvtEmX4Ayf_tt8GygBMkUB0qwHz-2cu4xYRdV-27Vrr7dWe4i1IOw1Z_wBtHE87RM4iivwjv-RSknoOXFlXC2KfHFd7gQvUcktKqjzity4VONKZwk; APISID=Z67YnZl2zT5R2_pu/AzGSh-D6M_19_1bbr; __Secure-1PSIDTS=sidts-CjcBkldj_xMPn64OTZFJpvFTo2GiIVQjOialP9i8TBsWkalDL8f3uapC2CFulsoSwkOROCBApCPqEAA; __Secure-1PAPISID=7whsbqWiuTxp8gwA/ApzfH4xDxiL4Eflsb; OSID=g.a000EAnE_Q13uBnl_axcMN8BorxCZK3FaD3OG4_r9U5zULSnHszeDUf7N1_P_Q7LcOhi4LovsQACgYKAVYSARESFQHGX2MiLHWii1fffj9GjE4T0uIo_xoVAUF8yKq5BjAxGU1Ik-lHRfCprJw50076; __Secure-3PSID=g.a000EAnE_T0JywRZbOELfhlPQ4AhSF-uhG41Ui6DjbkMcMP5OLV5fJw04xYfRhVxuVl0ZG9VbgACgYKAe8SARESFQHGX2Mie3JTnALUZngeIxoiWQksoRoVAUF8yKo6HXLs4DlSye5fzM5R-q0j0076; __Secure-1PSID=g.a000EAnE_T0JywRZbOELfhlPQ4AhSF-uhG41Ui6DjbkMcMP5OLV5Rzx3i-dRxkg77_gcowW8CwACgYKAQQSARESFQHGX2Mim2HJipXmSMp9wd_82YDHvxoVAUF8yKo9docZvQ7CKaF31M4uLhAT0076; __Secure-1PSIDCC=APD_SKExCIaFdf2bEVywuO9NNOkQp0321ECMeTVD0-E4To5UnWxK77ENJSt9Wyzb61eEmbI2; __Secure-1PSIDRTS=sidts-CjcBkldj_xMPn64OTZFJpvFTo2GiIVQjOialP9i8TBsWkalDL8f3uapC2CFulsoSwkOROCBApCPqEAA; __Secure-3PSIDCC=APD_SKFQyhzwLmBDJV_MWYOGpFXATpfakDshKObNpZwFEuoBtLwceOjbBivFXgpOd9izS5uo; __Secure-3PSIDRTS=sidts-CjcBkldj_xMPn64OTZFJpvFTo2GiIVQjOialP9i8TBsWkalDL8f3uapC2CFulsoSwkOROCBApCPqEAA; __Secure-3PSIDTS=sidts-CjcBkldj_xMPn64OTZFJpvFTo2GiIVQjOialP9i8TBsWkalDL8f3uapC2CFulsoSwkOROCBApCPqEAA; __Secure-OSID=g.a000EAnE_Q13uBnl_axcMN8BorxCZK3FaD3OG4_r9U5zULSnHszeho0JwgGMYQ5ymeWecalXKQACgYKAXISARESFQHGX2Mi-yAXlmLCKWGPAYQRjz-GgxoVAUF8yKq9Xizv5KLnG689hsDDSNoC0076; __Secure-STRP=ABNhA6hWP9ucYzseHiIdMvTS1rFX4-bkMA9aTFOTgRP0W99jE-uDSdqzjaQzhV1hAOi-mU4Kzm-CkjBHL1IGyMOv-ttBBv9dNqVY; COMPASS=appsfrontendserver=CgAQqvvx1gYagwEACWuJV_VFZRGzrcfjdVtp-A7It-_KxyNmdzwD9f0UPbpQq2zmwh1otkBfFC18IOaT4TZpW-M1cx89GZwsTzE9xHzvro_qPHfKbl4DoTprEOU6VNnDsmM3BCQtPRRlWflWyY6LVNJq_ZeSqc8sGVhMEytzUelSfNUnDQ-rHg9vzUXcjyABMAE; HSID=AGiRJ8Jkg8__26fJw; SEARCH_SAMESITE=CgQI3aEB; SID=g.a000EAnE_T0JywRZbOELfhlPQ4AhSF-uhG41Ui6DjbkMcMP5OLV5ogx6j2_64lyyr7xt9SPD8wACgYKAU0SARESFQHGX2MiagCKVg5s10Gb2EbDAkSN7xoVAUF8yKp7xx3TG2tdcAn3M2qHibe70076; SIDCC=APD_SKG9Q30edTc0oSAKCo8TZB6qkdv68P7OAjkUep3PaT53RnjQmnlJxSiUynrhMAhVIkRX; SSID=AVBk7KPWXsRJNNKVm"

app.whenReady().then(async () => {
  const eng = new FBRegisterEngine({})
  console.log('[test] BẮT ĐẦU — cookie ' + gmailCookie.length + ' ký tự')
  const res = await eng.registerSingleAccount({
    mode: 'tempmail',
    emailProvider: 'gmail',
    proxy: '115.77.136.170:15235',
    showBrowser: true,
    slot: 0,
    regVia: 'web',
    gmailVariant: 'plus',
    gmailCookie,
    onLog: (m) => console.log(m.replace(/^\[[^\]]+\]\s*/, ''))
  })
  console.log('[test] KẾT QUẢ: ' + JSON.stringify({ success: res.success, status: res.status, email: res.email, uid: res.uid, error: (res.error || '').substring(0, 200) }))
  app.quit()
}).catch(e => { console.error('[test] LỖI:', e.message); app.quit() })
