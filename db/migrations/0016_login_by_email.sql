-- Sign in with email and password only. While signing in, the API exposes the user rows for the typed
-- email (in every company) and checks the password against each; the company code is asked for only
-- when the same email and password match more than one company.
CREATE POLICY users_by_login_email ON users FOR SELECT
    USING (email = NULLIF(current_setting('app.login_email', true), '')::citext);
