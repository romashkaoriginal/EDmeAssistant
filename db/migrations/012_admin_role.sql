-- Admins are tutors with an elevated flag: the bot shows an extra "Админ-панель"
-- entry in the main menu and gates the admin screens on this column.
ALTER TABLE tutors ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;

-- Bootstrap the first admin by phone. The tutor row may not exist yet (tutors
-- are synced from Moy Klass on demand); the bot also re-applies this flag at
-- login/sync time for the same number, so the admin is granted whenever the
-- profile first appears. Phones are stored digits-only (see upsertMoyKlassTutor).
UPDATE tutors SET is_admin = TRUE WHERE phone = '375445839141';
