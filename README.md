# MirrorChat
Anonymous text and video chat on Supabase. Static HTML, no build step.

- `index.html`: landing page
- `chat.html`: public text room (realtime, with MirrorBot)
- `video.html`: random one-to-one video chat

1. Run `schema.sql` and `schema_video.sql` in the Supabase SQL editor.
2. Put your publishable key in `config.js` (`setup.sh` generates it from `.env`).
3. Serve the folder (`python3 -m http.server`) and open `index.html`.
