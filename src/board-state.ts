import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Db } from "./db.js";
import { quarantineWorkspace, type WorkspaceConfig } from "./workspace.js";

/** 盤面プロセスに固定の保護対象1つ(ADR 0040)。`label` は quarantine / 拒否の
 *  文面にそのまま出るので、人間が「どれを動かせばよいか」を読める綴りにする
 *  (env 変数名を含む)。 */
export interface BoardStatePath {
  label: string;
  path: string;
}

/** 盤面プロセスが固定で持つ、保護対象の在り処(ADR 0040 の5点)。**workspace 毎に
 *  変わる保護対象は存在しない** — 検査は「盤面側の固定リスト × workspace パス」の
 *  総当たりである。並ぶ*パス*の数は5とは限らない: GitHub token は env 未設定なら
 *  落ち、5点目の「実行 checkout」は cwd と配信元が一致しなければ2つになる。
 *  Moonshot キー(ADR 0097 決定4)は渡されたときだけ並ぶ — 合成 root 以外から
 *  組む呼び出し側(テスト等)に既定パスの強制を持ち込まないため。
 *  env の読み出しそのものは合成 root(main.ts)に留め、ここは解決済みの値だけを
 *  受ける。 */
export interface BoardStatePathsInput {
  /** `TIDEPOOL_DB`。SQLite のサイドカー(`-wal` / `-shm`)は同じディレクトリの
   *  兄弟なので、判定は DB パス基準で足りる。 */
  dbPath: string;
  /** `TIDEPOOL_WORKER_LOGS` — stream-json 監査記録の置き場。監査対象が自分の
   *  監査記録を書き換えられる形を塞ぐ。 */
  workerLogDir: string;
  /** `TIDEPOOL_API_TOKEN_FILE`(既定 `~/.tidepool/api-token`)。持つのはハッシュ
   *  だけだが、**書ければ**自分の知るハッシュへ差し替えて人間面 credential を
   *  偽造できる。 */
  apiTokenFile: string;
  /** `TIDEPOOL_GITHUB_TOKEN_FILE` — **平文**。workspace 配下に入ると work
   *  プロファイルの `allowRead` で読め、「worker は GitHub credential を一切
   *  持たない」(ADR 0024)が静かに崩れる。env 未設定 → 盤面に GitHub 識別情報が
   *  無い(ADR 0024 の fail-closed な不在)ので、守る対象そのものが存在しない。 */
  githubTokenFile?: string;
  /** `TIDEPOOL_MOONSHOT_API_KEY_FILE`(既定 `~/.tidepool/moonshot-api-key`)—
   *  **平文**(ADR 0097 決定4)。githubTokenFile と同じ罠: workspace 配下に入ると
   *  work プロファイルの `allowRead` で読め、Moonshot の従量課金キーが worker の
   *  手に渡る。 */
  moonshotApiKeyFile?: string;
  /** 盤面の実行 checkout(ADR 0040 の5点目)。盤面は `public/` の静的資産を
   *  実行中の checkout から配信するので、走っている checkout 自体が workspace に
   *  なると worker が `public/index.html` を書き換えられ、次のリロードで人間の
   *  ブラウザに届く。状態ファイルの置き場をどう動かしてもこの穴は残る。
   *
   *  **cwd と配信元は原理的に別物**なので両方受ける: 既定の状態パス
   *  (`board.sqlite` / `worker-logs`)が相対で解決される先は cwd だが、静的資産を
   *  実際に配信するのはモジュールの位置から導いた checkout(server.ts の `root`)で
   *  あり、リポジトリ外から起動すれば一致しない。ADR 0040 が「cwd」と書いたのは
   *  両者が一致する運用を前提にした綴りであって、守りたいのは「走っている
   *  checkout」そのものである。 */
  cwd: string;
  servedRoot: string;
}

export function boardStatePaths(input: BoardStatePathsInput): BoardStatePath[] {
  const checkouts: BoardStatePath[] = [
    { label: "the board's own working directory (process cwd)", path: input.cwd },
  ];
  // 一致するのが通常の運用(リポジトリのルートから起動する)— そのときは同じ
  // パスを2度検査しない
  if (resolve(input.servedRoot) !== resolve(input.cwd)) {
    checkouts.push({
      label: "the board's own checkout serving public/ (module root)",
      path: input.servedRoot,
    });
  }
  return [
    { label: "board database (TIDEPOOL_DB)", path: input.dbPath },
    { label: "worker logs (TIDEPOOL_WORKER_LOGS)", path: input.workerLogDir },
    { label: "human-surface token file (TIDEPOOL_API_TOKEN_FILE)", path: input.apiTokenFile },
    ...(input.githubTokenFile === undefined
      ? []
      : [
          {
            label: "GitHub token file (TIDEPOOL_GITHUB_TOKEN_FILE)",
            path: input.githubTokenFile,
          },
        ]),
    ...(input.moonshotApiKeyFile === undefined
      ? []
      : [
          {
            label: "Moonshot API key file (TIDEPOOL_MOONSHOT_API_KEY_FILE)",
            path: input.moonshotApiKeyFile,
          },
        ]),
    ...checkouts,
  ];
}

/** 重なり検査の答え。**boolean ではない**: 「重なった」と「判定できなかった」は
 *  同じ fail-closed でも波及範囲が違う — 解決できない *workspace* パスは
 *  workspace 1つを quarantine するだけだが、解決できない *保護対象* パスは
 *  全 workspace を「重なり」に倒す。ただしその区別を運ぶのは**文面であって型では
 *  ない**(containment.ts と同じ線: 止め方が1つである以上、答えの型も1つでよい)—
 *  4つの執行点はいずれも「重なりがあれば止める」しかしないので、分岐する型を
 *  持たせても読む者がいない。 */
export interface BoardStateOverlap {
  /** quarantine の cause / 登録拒否の文面にそのまま載る英文。 */
  reason: string;
}

/** パス区切りを尊重した包含判定(ADR 0040)。文字列の前置比較は
 *  `/opt/tidepool` と `/opt/tidepool-workspaces` の境界で誤検知する。
 *  同一パス(`relative` が空)も包含に含める。 */
function contains(ancestor: string, descendant: string): boolean {
  const rel = relative(ancestor, descendant);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** darwin は case-insensitive に比較する(APFS 既定)。realpath は実在パスを
 *  「登録されている表記」へ直す保証がない — 大文字違いの綴りで開けてしまう
 *  ファイルシステムでは、綴りの差を比較側で吸収しないと重なりを見落とす。
 *  linux は逆に、綴りが違えば本当に別のディレクトリなので落としてはならない。 */
function forComparison(path: string, platform: NodeJS.Platform): string {
  return platform === "darwin" ? path.toLowerCase() : path;
}

/** 比較の直前に realpath で正規化する(ADR 0040)— symlink 越しの別綴りが
 *  「重なっていない」に見えるのを防ぐ。
 *
 *  **まだ存在しないパスは親を辿って realpath + 字句結合**する。盤面の保護対象は
 *  存在しないのが正常な瞬間がある(token をまだ発行していない盤面の
 *  `~/.tidepool/api-token`、登録の門の clone / 新規作成モードが指す未作成の
 *  ディレクトリ)。ここで fail-closed に倒すと、新品の盤面が全 workspace を
 *  quarantine することになる。存在しない末端に symlink は在り得ないので、
 *  実在する最も深い祖先まで解決すれば嘘は付かれない。
 *
 *  **ENOENT 以外の失敗は解決不能**として undefined を返す(ELOOP・EACCES など)。
 *  「判定できなかった」を「問題なし」と読まないのが ADR 0033 の settings ガードと
 *  同じ線であり、その fail-closed は呼び出し側が担う。 */
function resolveForComparison(path: string): { resolved: string } | { cause: string } {
  let current = resolve(path);
  const trailing: string[] = [];
  for (;;) {
    try {
      return { resolved: join(realpathSync(current), ...trailing) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        return { cause: err instanceof Error ? err.message : String(err) };
      }
    }
    const parent = dirname(current);
    // ルートまで ENOENT で登り切った(現実には起きないが、無限ループは作らない)
    if (parent === current) return { cause: `no existing ancestor of ${path} could be resolved` };
    trailing.unshift(basename(current));
    current = parent;
  }
}

/** 盤面の状態パスと workspace パスの交差検査(ADR 0040)。重なりが1つでも
 *  見つかればその1件を返し、無ければ undefined。 */
export function boardStateOverlap(
  workspacePath: string,
  paths: BoardStatePath[],
  platform: NodeJS.Platform = process.platform,
): BoardStateOverlap | undefined {
  const workspace = resolveForComparison(workspacePath);
  if ("cause" in workspace) {
    return {
      reason:
        `workspace path ${workspacePath} could not be resolved (${workspace.cause}) — ` +
        "whether it overlaps the board's own state paths is unknown, and unknown is not safe (ADR 0040)",
    };
  }
  for (const target of paths) {
    const candidate = resolveForComparison(target.path);
    if ("cause" in candidate) {
      return {
        reason:
          `the board's ${target.label} at ${target.path} could not be resolved ` +
          `(${candidate.cause}) — whether a workspace overlaps it is unknown, and unknown ` +
          "is not safe (ADR 0040)",
      };
    }
    const a = forComparison(workspace.resolved, platform);
    const b = forComparison(candidate.resolved, platform);
    if (contains(a, b) || contains(b, a)) {
      return {
        reason:
          `workspace path ${workspacePath} overlaps the board's ${target.label} ` +
          `at ${target.path} — a worker's write radius is its workspace (ADR 0033), so the ` +
          "board's own state would be inside it (ADR 0040). Move the workspace or the board's " +
          "state so the two do not intersect",
      };
    }
  }
  return undefined;
}

/** boot 時の一斉検査(ADR 0040)。登録済みの全 workspace に pickup と同じ検査を
 *  掛け、該当を最初から needs-human にする — 「WebUI から実行時に登録できる」以上
 *  boot 一点では取りこぼすので、これは**床ではなく早く騒ぐ側**であり、床は
 *  pickup 側(claude-worker.ts)にある。
 *
 *  **起動そのものは拒まない**: 起動拒否は「人間面は開いたままが復旧経路」
 *  (ADR 0036 の fail-open)と衝突する。列挙自体の失敗(registry の yaml が壊れて
 *  いる、clone が読めない)も同じ線で握り潰してログに落とす — 検査ができなかった
 *  ことで盤面が起動しなくなるほうが、直す手段を人間から奪う。 */
export function sweepBoardStateOverlap(
  db: Db,
  paths: BoardStatePath[],
  listWorkspaces: () => WorkspaceConfig[],
  now: Date,
): void {
  let workspaces: WorkspaceConfig[];
  try {
    workspaces = listWorkspaces();
  } catch (err) {
    console.error(
      "[board-state] could not enumerate registered workspaces for the ADR 0040 overlap sweep; " +
        `pickup still checks each workspace as it is picked up (${String(err)})`,
    );
    return;
  }
  for (const workspace of workspaces) {
    const overlap = boardStateOverlap(workspace.path, paths);
    if (overlap) quarantineWorkspace(db, workspace.name, new Error(overlap.reason), now);
  }
}
