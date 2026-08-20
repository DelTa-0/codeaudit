-- Sign in with Google, as a second OAuth identity beside GitHub.
--
-- TEXT, not BIGINT like github_user_id: Google's `sub` is documented as an
-- opaque string that happens to look numeric today. Storing it as a number
-- would work until the day it does not, and the failure would be a user who
-- cannot sign in rather than an error anyone sees.

ALTER TABLE users ADD COLUMN google_user_id TEXT UNIQUE;
