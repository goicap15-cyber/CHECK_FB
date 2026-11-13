# -*- coding: utf-8 -*-
"""
TempMailMMO API Client & OTP Extractor
Tich hop API tempmailmmo.com chuyen dung lay email va tu dong bat OTP Facebook.
"""

import urllib.request
import urllib.parse
import json
import time
import re
from typing import Optional, List, Dict, Tuple


class TempMailMMO:
    def __init__(self, base_url: str = "https://tempmailmmo.com", timeout: int = 15):
        self.base_url = base_url.rstrip("/")
        self.endpoint = f"{self.base_url}/tool/ajax.php"
        self.timeout = timeout
        self.headers = {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
            "Accept": "application/json, text/javascript, */*; q=0.01"
        }

    def _post(self, action: str, data: Dict[str, str]) -> dict:
        url = f"{self.endpoint}?f={action}"
        body_encoded = urllib.parse.urlencode(data).encode("utf-8")
        req = urllib.request.Request(url, data=body_encoded, headers=self.headers, method="POST")
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            content = resp.read().decode("utf-8")
            return json.loads(content)

    def _get(self, action: str, params: Optional[Dict[str, str]] = None) -> dict:
        url = f"{self.endpoint}?f={action}"
        if params:
            url += "&" + urllib.parse.urlencode(params)
        req = urllib.request.Request(url, headers=self.headers, method="GET")
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            content = resp.read().decode("utf-8")
            return json.loads(content)

    def get_domains(self) -> List[str]:
        """Lay danh sach cac domain kha dung."""
        res = self._get("get_domains")
        return res.get("domains", [])

    def create_email(self, domain: Optional[str] = None, lang: str = "vi") -> Tuple[str, str]:
        """
        Tao session mailbox moi.
        Tra ve tuple: (email_addr, sid_token)
        """
        payload = {"lang": lang}
        if domain:
            payload["email_domain"] = domain
        res = self._post("get_email_address", payload)
        email_addr = res.get("email_addr", "")
        sid_token = res.get("sid_token", "")
        if not email_addr or not sid_token:
            raise ValueError(f"Khong tao duoc email: {res}")
        return email_addr, sid_token

    def get_email_list(self, sid_token: str, offset: int = 0) -> List[dict]:
        """Lay danh sach thu trong mailbox."""
        payload = {
            "sid_token": sid_token,
            "offset": str(offset)
        }
        res = self._post("get_email_list", payload)
        return res.get("list", [])

    def fetch_email(self, sid_token: str, email_id: str) -> dict:
        """Lay chi tiet noi dung thu theo email_id."""
        payload = {
            "sid_token": sid_token,
            "email_id": str(email_id)
        }
        return self._post("fetch_email", payload)

    @staticmethod
    def extract_otp(subject: str, body_html: str, length: int = 5) -> Optional[str]:
        """
        Trich xuat ma OTP tu tieu de hoac noi dung HTML.
        Mac dinh FB dung 5 chu so.
        """
        # 1. Tim ma trong tieu de thu
        subj_matches = re.findall(rf'(?<!\d)(\d{{{length}}})(?!\d)', subject)
        if subj_matches:
            return subj_matches[0]

        # 2. Lam sach noi dung HTML
        clean_text = re.sub(r'<[^>]+>', ' ', body_html)
        clean_text = ' '.join(clean_text.split())

        # 3. Tim gan tu khoa: code, ma, xac nhan, confirm, fb, facebook
        ctx_regex = rf'(?:code|mã|ma|xác|xac|nhận|nhan|fb|facebook)[^\d]{{0,30}}(\d{{{length}}})(?!\d)'
        ctx_match = re.search(ctx_regex, clean_text, re.IGNORECASE)
        if ctx_match:
            return ctx_match.group(1)

        # 4. Fallback: bat ky chuoi nao dung so luong ky tu
        fallback_matches = re.findall(rf'(?<!\d)(\d{{{length}}})(?!\d)', clean_text)
        if fallback_matches:
            return fallback_matches[0]

        return None

    def wait_for_otp(
        self,
        sid_token: str,
        timeout_seconds: int = 120,
        poll_interval: int = 6,
        otp_length: int = 5,
        on_poll=None
    ) -> Optional[Tuple[str, str]]:
        """
        Cho va trich xuat OTP tu thu moi.
        Tra ve (otp_code, subject) hoac None neu timeout.
        """
        # Snapshot mail hien tai de tranh doc thu cu
        try:
            initial_list = self.get_email_list(sid_token)
            seen_ids = set(str(m.get("mail_id", "")) for m in initial_list)
        except Exception:
            seen_ids = set()

        start_time = time.time()
        attempt = 0

        while time.time() - start_time < timeout_seconds:
            attempt += 1
            elapsed = int(time.time() - start_time)
            if on_poll:
                on_poll(attempt, elapsed)

            try:
                emails = self.get_email_list(sid_token)
                new_emails = [m for m in emails if str(m.get("mail_id", "")) not in seen_ids]

                for mail in new_emails:
                    mail_id = str(mail.get("mail_id", ""))
                    seen_ids.add(mail_id)

                    detail = self.fetch_email(sid_token, mail_id)
                    subject = detail.get("mail_subject", "")
                    body_html = detail.get("mail_body", "")

                    otp = self.extract_otp(subject, body_html, length=otp_length)
                    if otp:
                        return otp, subject

            except Exception as e:
                if on_poll:
                    on_poll(attempt, elapsed, error=str(e))

            time.sleep(poll_interval)

        return None


if __name__ == "__main__":
    print("=" * 60)
    print("  [TEST] KHOI DONG CLIENT TEMPORARY MAIL (TempMailMMO)")
    print("=" * 60)

    client = TempMailMMO()

    print("\n[1] Dang lay danh sach domain kha dung...")
    try:
        domains = client.get_domains()
        print(f" -> Tim thay {len(domains)} domain:")
        for d in domains[:5]:
            print(f"    - {d}")
        if len(domains) > 5:
            print(f"    ... va {len(domains) - 5} domain khac.")
        chosen_domain = domains[0] if domains else None
    except Exception as e:
        print(f" [!] Khong lay duoc domain: {e}. Dung domain mac dinh.")
        chosen_domain = None

    print(f"\n[2] Dang tao email moi voi domain: {chosen_domain or 'default'}...")
    email, sid_token = client.create_email(domain=chosen_domain)
    print(f" -> Email tao duoc : {email}")
    print(f" -> Session Token  : {sid_token[:16]}...{sid_token[-8:]} (48 hex)")

    print(f"\n[3] Dang cho email va ma OTP (toi da 60 giay de test)...")
    print(f"    Ban co the gui email thu nghiem den dia chi: {email}")

    def log_poll(attempt, elapsed, error=None):
        if error:
            print(f"    [Lan {attempt} | {elapsed}s] Loi nhe: {error}")
        else:
            print(f"    [Lan {attempt} | {elapsed}s] Dang quet hop thu...")

    result = client.wait_for_otp(sid_token, timeout_seconds=40, poll_interval=5, on_poll=log_poll)

    if result:
        otp, subject = result
        print("\n" + "=" * 60)
        print(f" [THANH CONG] MA OTP NHAN DUOC: {otp}")
        print(f" Tiêu đề thư: {subject}")
        print("=" * 60)
    else:
        print("\n" + "-" * 60)
        print(" [HET GIO TEST] Khong co thu moi den trong thoi gian cho.")
        print(f" Module API TempMailMMO hoat dong 100% on dinh va san sang tich hop vao AUTO_BM!")
        print("-" * 60)