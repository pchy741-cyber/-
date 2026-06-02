-- WebAuthn (FIDO2) 지문인식/생체인증 자격증명 저장
CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id TEXT PRIMARY KEY,                          -- credential ID (base64url)
  public_key BYTEA NOT NULL,                     -- COSE public key
  counter BIGINT NOT NULL DEFAULT 0,             -- signature counter (replay 방지)
  device_name TEXT NOT NULL DEFAULT 'unknown',   -- 디바이스 별명 ("CEO 아이폰" 등)
  transports TEXT[],                             -- ['internal', 'hybrid'] 등
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);
