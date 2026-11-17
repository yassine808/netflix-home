import { resolveImdbId } from "file:///D:/Projects/netflix-home/server/imdb.js";
const base = "http://127.0.0.1:3000";
const lib = await (await fetch(`${base}/api/library`)).json();
const item = lib.items.find((i) => /queen's gambit/i.test(i.seriesTitle || ""));
console.log("item:", item.fileName, "S" + item.season + "E" + item.episode, "dur", item.durationSec);
const imdb = await resolveImdbId(item);
console.log("imdb:", imdb);
if (imdb) {
  const res = await fetch(`https://rest.opensubtitles.org/search/imdbid-${imdb.replace(/^tt/, "")}/season-${item.season}/episode-${item.episode}/sublanguageid-eng`, { headers: { "User-Agent": "TemporaryUserAgent" } });
  console.log("os status", res.status);
  if (res.ok) {
    const list = await res.json();
    console.log("hits", list.length);
    for (const hit of list.slice(0, 6)) console.log(String(hit.SubDownloadsCnt).padStart(6), hit.SubFormat, hit.SubFileName);
  }
}
