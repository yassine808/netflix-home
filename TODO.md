# TODO

- [ ] never show downlaods when starting a dowload, unless clicked

  *Not done - queueing a download still calls `openDownloads()` (`public/app.js:4013`, `4144`, `4981`).*

- [x] in idle screen add logo of the movie

  *Done - the paused screen draws `#idleLogo` from `/api/art/<id>/logo` and falls back to the text title when the title has no wordmark (`public/watch.html:138`, `public/watch.js:1505`).*

- [x] add "skip intro" button if the movie have intro

  *Done - `fromMoviesDb()` in `server/intro.js:233` asks IntroDB's movie segments, then TheIntroDB; the button only appears for a film one of them actually timed (The Matrix 0-40 s, Inception 0-38 s), and a `no_intro` flag or a window opening after 15 min drops it (Iron Man's sting is filed at 2 h 5 min).*

- [ ] find a title the online catalogue does not carry (Hidden Love, 2023)

  *Not done - Castle search for "hidden love" returns 462 loose matches and none is the drama (the channel parameter is ignored, every value answers the same catalogue), so there is no Castle id to open or queue. A Cinemeta search plus the existing Torrentio ranking would download it without Castle.*

- [x] add player drag preview frames

  *Done - the sprite grid loads on the first timeline hover (`public/watch.js:1079`, `server/frames.js`).*

- [x] fix delete videos not wokring inside the website.

  *Done - the server closes its own player streams, then retries the unlink (`server/index.js:1024`).*

- [x] anything that's downloaded, should be added to the database, only keep the videos outside (same as before in folder) and save their path inthe database for each

  *Done - the rescan after a job upserts the file and its `rel_path` into the `items` table (`server/library.js:441`).*

- [x] add delete all button close to doanload all button

  *Done - `#castleSeasonDelete` sits right next to `#castleSeasonDownload` (`public/index.html:374`).*

- [ ] when an episode is deleted, keep progress viewed, dont remove it, but update the button from "play" to "download"

  *Not done - progress is keyed by the local item id, and the rows only paint for files on disk (`public/app.js:3896`).*

- [ ] In catalogue, only show "resume", no season or episode

  *Not done - the sheet button still reads "Resume S02E05" and "Download Season 2" (`public/app.js:4304`).*

- [x] Fix video prioritizing + seeds etc (best score)

  *Done - one deterministic score per release, the healthier swarm wins (`server/torrentio.js:347`).*

- [x] The download speed is very low, forget format, as long as it's 1080p or above then download it, priority are for those who have higher seed etc + low size at the same time

  *Done - 1080p or 2160p only, seeders x10 capped at 700, then size bands (`server/torrentio.js:333`).*

- [x] the default for all players should be original dub, always! unless the user changed it in that serie!

  ![](image.png)

  *Done - track 1 is the original dub, and a choice saved for the series wins (`public/watch.js:808`).*
