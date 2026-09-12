# Dendarv v1.5

For local hot-seat play, open Dendarv_Play.html in a web browser. Use New to choose two or four players.

For online play, use the complete dendarv folder. With Node.js 20 or later, run `node server.mjs` inside that folder, then open http://127.0.0.1:4173 and choose BrezelPesk. No npm packages are needed.

For an existing Node deployment, replace its application source with the contents of the dendarv folder. Keep src/rooms.js and the other src files beside the server in their supplied paths. Existing persistent room data is not included in this package.

The source README and V1.5_SPECIFICATION.md describe the changes and the intentional digital Stockpile exception. The suite has 72 passing automated checks; browser layout and a live deployment were not verified in this revision.
