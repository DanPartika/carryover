-- Calendar feed capability (the plants-app pattern): Google Calendar polls an
-- ICS URL and cannot send bearer headers, so a 48-hex-char random secret in
-- the URL path IS the auth — per-user, unguessable, revoked by regeneration.
-- NULL means the feed is off. The unique index doubles as the lookup.
ALTER TABLE users ADD COLUMN calendar_token text UNIQUE;
