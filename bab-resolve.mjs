import { resolveImdbId } from "file:///D:/Projects/netflix-home/server/imdb.js";
const lib = await (await fetch("http://127.0.0.1:3000/api/library")).json();
const boys = lib.items.filter((i) => /the boys/i.test(i.seriesTitle || i.title || ""));
console.log("boys items:", boys.length);
for (const i of boys) console.log(JSON.stringify({ id: i.id, title: i.title, seriesTitle: i.seriesTitle, seriesKey: i.seriesKey, season: i.season, episode: i.episode, year: i.year }));
const sample = { ...boys[0], title: boys[0].seriesTitle || boys[0].title };
console.log("resolve with series:", await resolveImdbId(sample));
console.log("resolve episode item:", await resolveImdbId(boys[0]));
