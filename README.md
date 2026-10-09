# Lamblooket

Quiz games for the classroom: teachers build question sets, pupils join a game with a code. No pupil accounts, and no pupil data is stored.

- `index.html` — pupil join page
- `teacher.html` — teacher sign-in, set library, editor and pupil-view preview
- `assets/` — styles, scripts and public config
- `supabase/schema.sql` — database setup (folders and sets only)

Teacher accounts are created by the admin in Supabase (Authentication → Users); public sign-up is off.
