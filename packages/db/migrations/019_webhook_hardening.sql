-- 019: webhook endpoint hardening (docs/security/REVIEW-stage2.md SEC-012 and SEC-019).
--
-- SEC-012 (SSRF). The old CHECK was url ~ '^https?://'. The database now refuses, as the last line of defence:
--   * anything but https, userinfo (user:pass@), IPv6 literals, backslashes, whitespace, control and non-ASCII characters;
--   * any host that is not a DNS name with a letter-initial top-level label, which rules out every IPv4 literal in every spelling
--     (dotted, 127.1, decimal 2130706433, hex 0x7f000001, octal) and so also the metadata address 169.254.169.254;
--   * single-label hosts (service names such as db or redis) and reserved or internal suffixes:
--       localhost, local, localdomain, internal, intranet, lan, home, corp, private, svc, invalid, test, example, arpa (home.arpa);
--   * ports other than 443 and 8443.
-- A hostname that RESOLVES to a private address (127.0.0.1.nip.io, a DNS rebinding record, a CNAME to an internal name) passes any
-- text check. The dispatcher MUST resolve the name at delivery time, reject loopback / link-local / private / CGNAT / unique-local /
-- IPv4-mapped IPv6 / metadata addresses, connect to the validated IP (pinned, no second lookup), refuse redirects, cap the
-- response size and use a fixed timeout. http://localhost is deliberately NOT allowed in the database, not even in development.
--
-- SEC-019 (secret storage). `secret_ciphertext` is written by the application (AES-256-GCM, 96-bit random nonce, AAD = tenant id +
-- endpoint id, key from the environment). The row now records which key version sealed it and can hold the previous secret for a
-- rotation window, so a receiver can verify either signature while it switches.

CREATE FUNCTION webhook_url_is_safe(p_url text) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$
    SELECT p_url IS NOT NULL
       AND char_length(p_url) <= 2000
       AND p_url ~ '^[!-~]+$'                       -- printable ASCII only
       AND position(chr(92) in p_url) = 0           -- no backslash
       AND p_url ~ '^https://[^/?#@:\[\]]+(:(443|8443))?([/?#].*)?$'
       AND coalesce(lower(substring(p_url from '^https://([^/?#@:\[\]]+)')) ~
                    '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$', false)
       AND char_length(substring(p_url from '^https://([^/?#@:\[\]]+)')) <= 253
       AND lower(substring(p_url from '^https://([^/?#@:\[\]]+)')) !~
           '(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|private|svc|invalid|test|example|arpa)$'
  $$;

-- Check constraints run the function with the inserting role's privileges.
GRANT EXECUTE ON FUNCTION webhook_url_is_safe(text) TO qenbel_app;

-- Rows that already break the rule are switched off and neutralised (the original text is kept in disabled_reason),
-- so the constraint can be added and no unsafe endpoint can ever be delivered to.
ALTER TABLE webhook_endpoints NO FORCE ROW LEVEL SECURITY;
UPDATE webhook_endpoints
   SET enabled = false,
       disabled_reason = 'url blocked by migration 019 (was: ' || left(url, 500) || ')',
       url = 'https://blocked.invalid-webhook.example.com/'
 WHERE NOT webhook_url_is_safe(url);
ALTER TABLE webhook_endpoints FORCE ROW LEVEL SECURITY;

ALTER TABLE webhook_endpoints DROP CONSTRAINT webhook_endpoints_url_check;
ALTER TABLE webhook_endpoints ADD CONSTRAINT webhook_endpoints_url_safe CHECK (webhook_url_is_safe(url));

ALTER TABLE webhook_endpoints
  ADD COLUMN secret_key_version smallint NOT NULL DEFAULT 1 CHECK (secret_key_version > 0),
  ADD COLUMN previous_secret_ciphertext text,
  ADD COLUMN previous_secret_expires_at timestamptz,
  ADD CONSTRAINT webhook_endpoints_previous_secret_pair
    CHECK ((previous_secret_ciphertext IS NULL) = (previous_secret_expires_at IS NULL));
