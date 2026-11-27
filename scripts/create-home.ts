/** `npm run create-home` — 盤面の家を作る(ADR 0436 決定5)。起動前に人間が打つ。既にある家は作り直さず、識別子を表示する。 */
import { BoardHomeMissingError, createBoardHome, resolveBoardPlaces } from "../src/board-home.js";

try {
  const { home } = resolveBoardPlaces(process.env);
  const { identifier, created } = createBoardHome(home);
  console.log(`${created ? "Created the board home" : "The board home already exists"} at ${home}\nidentifier: ${identifier}`);
} catch (err) {
  if (!(err instanceof BoardHomeMissingError)) throw err;
  process.stderr.write(`Error: ${err.message}\n`);
  process.exitCode = 1;
}
