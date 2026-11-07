import { getStore } from "@netlify/blobs";
import type { Context } from "@netlify/functions";

interface PlayerLeaderboardEntry {
  isLocalPlayer?: boolean;
  uid: string;
  avatar?: string;
  name: string;
  solved: number;
  trophies: number;
  level: number;
}

interface CloudAccountRecord {
  username: string;
  usernameLower: string;
  email: string;
  emailLower: string;
  passwordHash: string;
  passwordPlain?: string;
  isAdmin?: boolean;
  uid: string;
  createdAt: number;
  lastLoginAt: number;
  updatedAt: number;
  adminModifiedAt?: number;
  profile: {
    uid: string;
    avatarId: string;
    customAvatarDataUrl: string;
  };
  economy: {
    beCoins: number;
    vipTokens: number;
    hintsLeft: number;
    level: number;
    xp: number;
  };
  stats: {
    solved: number;
    trophies: number;
    level: number;
  };
  matchHistory: Array<Record<string, unknown>>;
}

interface MasterSnapshot {
  version: number;
  updatedAt: number;
  adminModifiedAt?: number;
  playerName: string;
  email?: string;
  passwordHash?: string;
  passwordPlain?: string;
  profile: {
    uid: string;
    avatarId: string;
    customAvatarDataUrl: string;
  };
  economy: {
    beCoins: number;
    vipTokens: number;
    hintsLeft: number;
    level: number;
    xp: number;
  };
  leaderboard: PlayerLeaderboardEntry[];
  matchHistory: Array<Record<string, unknown>>;
}

const ACCOUNTS_INDEX_KEY = "cloud_accounts_index_v2";
const GLOBAL_LEADERBOARD_KEY = "global_leaderboard_v1";
const ADMIN_AUTH_KEY = "cloud_admin_auth_v1";
const DEFAULT_ADMIN_EMAIL = "admin@quizdasmaterias.com";
// Hash correspondente a hashAccountPassword('admin123')
const DEFAULT_ADMIN_HASH = "qz_16c80e7a29bf59";

const PURGED_AND_HIDDEN_NAMES = new Set([
  "donodoservidor",
  "dono do servidor",
  "admin"
]);

function isPurgedOrOwnerAccount(name?: string, uid?: string): boolean {
  const cleanUid = (uid || "").trim().toUpperCase();
  if (cleanUid === "#BR-0000001") return true;
  const cleanName = (name || "").trim().toLowerCase();
  return PURGED_AND_HIDDEN_NAMES.has(cleanName);
}

function sanitizeUidKey(rawUid: string): string {
  const cleaned = (rawUid || "").trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "");
  return cleaned ? `player_${cleaned}` : "";
}

function normalizeAccountKey(raw: string): string {
  return (raw || "").trim().toLowerCase();
}

function deduplicateIndexMap(indexMap: Record<string, CloudAccountRecord>): Record<string, CloudAccountRecord> {
  const cleanMap: Record<string, CloudAccountRecord> = {};
  const seenUids = new Set<string>();
  const seenEmails = new Set<string>();

  const entries = Object.entries(indexMap).sort(
    (a, b) => (Number(b[1]?.updatedAt) || 0) - (Number(a[1]?.updatedAt) || 0)
  );

  for (const [k, acc] of entries) {
    if (!acc || !acc.username) continue;
    if (isPurgedOrOwnerAccount(acc.username, acc.uid)) continue;
    const uid = (acc.uid || "").trim().toUpperCase();
    const email = (acc.email || "").trim().toLowerCase();
    if (uid && seenUids.has(uid)) continue;
    if (email && seenEmails.has(email)) continue;
    if (uid) seenUids.add(uid);
    if (email) seenEmails.add(email);
    cleanMap[email || normalizeAccountKey(acc.username) || k] = acc;
  }
  return cleanMap;
}

function snapshotFromAccountRecord(acc: CloudAccountRecord, leaderboard: PlayerLeaderboardEntry[] = []): MasterSnapshot {
  return {
    version: 2,
    updatedAt: acc.updatedAt || Date.now(),
    adminModifiedAt: acc.adminModifiedAt || 0,
    playerName: acc.username,
    email: acc.email,
    passwordHash: acc.passwordHash,
    passwordPlain: acc.passwordPlain || "",
    profile: acc.profile || { uid: acc.uid, avatarId: "cat_gamer", customAvatarDataUrl: "" },
    economy: acc.economy || { beCoins: 0, vipTokens: 0, hintsLeft: 2, level: 1, xp: 0 },
    leaderboard: leaderboard.length > 0
      ? leaderboard
      : [
          {
            isLocalPlayer: true,
            uid: acc.uid,
            name: acc.username,
            solved: acc.stats?.solved || 0,
            trophies: acc.stats?.trophies || 0,
            level: acc.economy?.level || 1,
          },
        ],
    matchHistory: Array.isArray(acc.matchHistory) ? acc.matchHistory : [],
  };
}

function findAccountInIndex(
  indexMap: Record<string, CloudAccountRecord>,
  query: string
): { key: string; acc: CloudAccountRecord } | null {
  const q = normalizeAccountKey(query);
  if (!q) return null;
  if (indexMap[q]) return { key: q, acc: indexMap[q] };

  for (const [k, acc] of Object.entries(indexMap)) {
    if (!acc) continue;
    if (
      (acc.emailLower && acc.emailLower === q) ||
      (acc.email && acc.email.toLowerCase() === q) ||
      (acc.usernameLower && acc.usernameLower === q) ||
      (acc.username && acc.username.toLowerCase() === q) ||
      (acc.uid && acc.uid.toLowerCase() === q)
    ) {
      return { key: k, acc };
    }
  }
  return null;
}

async function updateGlobalLeaderboardFromAccounts(
  store: ReturnType<typeof getStore>,
  indexMap: Record<string, CloudAccountRecord>,
  extraEntries: PlayerLeaderboardEntry[] = []
): Promise<PlayerLeaderboardEntry[]> {
  for (const [k, acc] of Object.entries(indexMap)) {
    if (!acc || isPurgedOrOwnerAccount(acc.username || k, acc.uid)) {
      delete indexMap[k];
    }
  }

  const currentGlobal =
    ((await store.get(GLOBAL_LEADERBOARD_KEY, { type: "json" })) as PlayerLeaderboardEntry[] | null) || [];
  const map = new Map<string, PlayerLeaderboardEntry>();

  for (const item of [...currentGlobal, ...extraEntries]) {
    if (!item || !item.name) continue;
    if (isPurgedOrOwnerAccount(item.name, item.uid)) continue;
    const entryKey = item.name.trim().toLowerCase();
    const prev = map.get(entryKey);
    if (!prev) {
      map.set(entryKey, {
        uid: item.uid || entryKey,
        name: item.name,
        avatar: item.avatar,
        solved: Number(item.solved) || 0,
        trophies: Number(item.trophies) || 0,
        level: Math.max(1, Number(item.level) || 1),
      });
    } else {
      prev.name = item.name || prev.name;
      prev.uid = item.uid || prev.uid;
      prev.avatar = item.avatar || prev.avatar;
      prev.solved = Math.max(prev.solved || 0, Number(item.solved) || 0);
      prev.trophies = Math.max(prev.trophies || 0, Number(item.trophies) || 0);
      prev.level = Math.max(prev.level || 1, Number(item.level) || 1);
    }
  }

  for (const acc of Object.values(indexMap)) {
    if (!acc || !acc.uid || isPurgedOrOwnerAccount(acc.username, acc.uid)) continue;
    const entryKey = acc.username.trim().toLowerCase();
    const prev = map.get(entryKey);
    const chosenAvatar = acc.profile?.customAvatarDataUrl || acc.profile?.avatarId || prev?.avatar;
    map.set(entryKey, {
      uid: acc.uid,
      name: acc.username,
      avatar: chosenAvatar,
      solved: Math.max(prev?.solved || 0, Number(acc.stats?.solved) || 0),
      trophies: Math.max(prev?.trophies || 0, Number(acc.stats?.trophies) || 0),
      level: Math.max(1, Number(acc.economy?.level) || Number(acc.stats?.level) || 1),
    });
  }

  const updatedGlobal = Array.from(map.values()).slice(0, 150);
  await store.setJSON(GLOBAL_LEADERBOARD_KEY, updatedGlobal);
  return updatedGlobal;
}

export default async (req: Request, _context: Context) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  try {
    const store = getStore({ name: "edurush-vault", consistency: "strong" });
    const url = new URL(req.url);

    // GET: Busca rápida de conta por UID ou E-mail, ou ranking global público
    if (req.method === "GET") {
      const uid = url.searchParams.get("uid") || "";
      const email = url.searchParams.get("email") || "";
      const rawIndex =
        ((await store.get(ACCOUNTS_INDEX_KEY, { type: "json" })) as Record<string, CloudAccountRecord> | null) || {};
      const indexMap = deduplicateIndexMap(rawIndex);
      const globalLeaderboard =
        ((await store.get(GLOBAL_LEADERBOARD_KEY, { type: "json" })) as PlayerLeaderboardEntry[] | null) || [];

      // Se nenhum parâmetro for informado, retorna o estado global público imediatamente
      if (!uid && !email) {
        return Response.json(
          {
            ok: true,
            globalLeaderboard,
            totalPlayers: Object.keys(indexMap).length,
          },
          { headers }
        );
      }

      const found = findAccountInIndex(indexMap, email || uid);
      if (found) {
        return Response.json(
          {
            ok: true,
            account: found.acc,
            snapshot: snapshotFromAccountRecord(found.acc, globalLeaderboard),
            globalLeaderboard,
          },
          { headers }
        );
      }

      const key = sanitizeUidKey(uid);
      if (!key) {
        return Response.json({ ok: false, error: "Account not found", globalLeaderboard }, { status: 404, headers });
      }
      const existing = (await store.get(key, { type: "json" })) as MasterSnapshot | null;
      if (existing === null) {
        return Response.json({ ok: false, error: "Account not found", globalLeaderboard }, { status: 404, headers });
      }
      return Response.json({ ok: true, snapshot: existing, globalLeaderboard }, { headers });
    }

    if (req.method === "POST") {
      const body = await req.json();
      const action = body?.action || "sync";
      const rawIndex =
        ((await store.get(ACCOUNTS_INDEX_KEY, { type: "json" })) as Record<string, CloudAccountRecord> | null) || {};
      let indexMap = deduplicateIndexMap(rawIndex);

      // ============================================================================
      // 1. LOGIN UNIFICADO POR E-MAIL OU NOME DE USUÁRIO (TABLET, CELULAR E PC)
      // ============================================================================
      if (action === "login") {
        const query = (body?.email || body?.username || "").trim();
        const passwordHash = body?.passwordHash || "";
        const passwordPlain = body?.passwordPlain || "";
        if (!query) {
          return Response.json({ error: "Missing email or username" }, { status: 400, headers });
        }

        const found = findAccountInIndex(indexMap, query);
        if (found) {
          if (found.acc.passwordHash && found.acc.passwordHash !== passwordHash) {
            return Response.json({ error: "Invalid password" }, { status: 401, headers });
          }
          if (passwordPlain) {
            found.acc.passwordPlain = passwordPlain;
          }
          found.acc.lastLoginAt = Date.now();
          indexMap[found.key] = found.acc;
          await store.setJSON(ACCOUNTS_INDEX_KEY, indexMap);

          const globalLeaderboard =
            ((await store.get(GLOBAL_LEADERBOARD_KEY, { type: "json" })) as PlayerLeaderboardEntry[] | null) || [];

          return Response.json(
            {
              ok: true,
              account: found.acc,
              snapshot: snapshotFromAccountRecord(found.acc, globalLeaderboard),
              globalLeaderboard,
            },
            { headers }
          );
        }

        return Response.json({ error: "Account not found" }, { status: 404, headers });
      }

      // ============================================================================
      // 1.5 RECUPERAÇÃO DE SENHA ("ESQUECI MINHA SENHA") POR E-MAIL CADASTRADO
      // ============================================================================
      if (action === "reset_password") {
        const emailQuery = (body?.email || "").trim().toLowerCase();
        const newPasswordHash = body?.passwordHash || "";
        const newPasswordPlain = body?.passwordPlain || "";

        if (!emailQuery || !newPasswordHash) {
          return Response.json({ error: "Missing email or new password" }, { status: 400, headers });
        }

        const found = findAccountInIndex(indexMap, emailQuery);
        if (!found) {
          return Response.json({ error: "Email not found" }, { status: 404, headers });
        }

        const now = Date.now();
        found.acc.passwordHash = newPasswordHash;
        if (newPasswordPlain) {
          found.acc.passwordPlain = newPasswordPlain;
        }
        found.acc.updatedAt = now;
        found.acc.adminModifiedAt = now;
        indexMap[found.key] = found.acc;
        await store.setJSON(ACCOUNTS_INDEX_KEY, indexMap);

        const globalLeaderboard =
          ((await store.get(GLOBAL_LEADERBOARD_KEY, { type: "json" })) as PlayerLeaderboardEntry[] | null) || [];
        const playerKey = sanitizeUidKey(found.acc.uid);
        const masterSnap = snapshotFromAccountRecord(found.acc, globalLeaderboard);
        if (playerKey) {
          await store.setJSON(playerKey, masterSnap);
        }

        return Response.json(
          {
            ok: true,
            account: found.acc,
            snapshot: masterSnap,
            globalLeaderboard,
          },
          { headers }
        );
      }

      // ============================================================================
      // 2. CADASTRO EXCLUSIVO POR E-MAIL NA NUVEM
      // ============================================================================
      if (action === "register") {
        const username = (body?.username || body?.snapshot?.playerName || "").trim();
        const email = (body?.email || username).trim().toLowerCase();
        const passwordHash = body?.passwordHash || "";
        const passwordPlain = body?.passwordPlain || body?.snapshot?.passwordPlain || "";
        const uid = body?.uid || body?.snapshot?.profile?.uid || `#BR-${Math.floor(1000000 + Math.random() * 9000000)}`;
        const snap = body?.snapshot as MasterSnapshot | undefined;

        if (!username || !email) {
          return Response.json({ error: "Missing username or email" }, { status: 400, headers });
        }

        const existingByEmail = findAccountInIndex(indexMap, email);
        if (
          existingByEmail &&
          existingByEmail.acc.uid !== uid &&
          existingByEmail.acc.passwordHash &&
          existingByEmail.acc.passwordHash !== passwordHash
        ) {
          return Response.json({ error: "Email already registered" }, { status: 409, headers });
        }

        const emailKey = normalizeAccountKey(email);
        const userKey = normalizeAccountKey(username);
        const now = Date.now();
        const myLeader = (snap?.leaderboard || []).find((p) => p.uid === uid || p.isLocalPlayer);

        const newRecord: CloudAccountRecord = {
          username,
          usernameLower: userKey,
          email,
          emailLower: emailKey,
          passwordHash,
          passwordPlain,
          isAdmin: false,
          uid,
          createdAt: existingByEmail?.acc?.createdAt || now,
          lastLoginAt: now,
          updatedAt: now,
          adminModifiedAt: existingByEmail?.acc?.adminModifiedAt || 0,
          profile: snap?.profile || { uid, avatarId: "cat_gamer", customAvatarDataUrl: "" },
          economy: snap?.economy || { beCoins: 0, vipTokens: 0, hintsLeft: 2, level: 1, xp: 0 },
          stats: {
            solved: Number(myLeader?.solved) || 0,
            trophies: Number(myLeader?.trophies) || 0,
            level: Number(snap?.economy?.level) || 1,
          },
          matchHistory: Array.isArray(snap?.matchHistory) ? snap!.matchHistory : [],
        };

        // Remove qualquer entrada anterior duplicada do mesmo UID ou Email
        for (const [k, oldAcc] of Object.entries(indexMap)) {
          if (oldAcc && (oldAcc.uid === uid || oldAcc.emailLower === emailKey)) {
            delete indexMap[k];
          }
        }
        indexMap[emailKey] = newRecord;
        indexMap = deduplicateIndexMap(indexMap);
        await store.setJSON(ACCOUNTS_INDEX_KEY, indexMap);

        const playerKey = sanitizeUidKey(uid);
        const globalLeaderboard = await updateGlobalLeaderboardFromAccounts(store, indexMap, snap?.leaderboard || []);
        const masterSnap = snapshotFromAccountRecord(newRecord, globalLeaderboard);
        if (playerKey) {
          await store.setJSON(playerKey, masterSnap);
        }

        return Response.json(
          {
            ok: true,
            account: newRecord,
            snapshot: masterSnap,
            globalLeaderboard,
          },
          { headers }
        );
      }

      // ============================================================================
      // 3. AÇÕES DO PAINEL ADMINISTRATIVO EXTERNO (admin.html)
      // ============================================================================
      if (action.startsWith("admin_")) {
        const storedAdminAuth = (await store.get(ADMIN_AUTH_KEY, { type: "json" })) as {
          email: string;
          passwordHash: string;
        } | null;

        const expectedEmail = storedAdminAuth?.email || DEFAULT_ADMIN_EMAIL;
        const expectedHash = storedAdminAuth?.passwordHash || DEFAULT_ADMIN_HASH;

        const reqAdminEmail = (body?.adminEmail || DEFAULT_ADMIN_EMAIL).trim().toLowerCase();
        const reqAdminHash = body?.adminPasswordHash || "";
        const reqAdminRawPass = body?.adminPassword || "";

        const isAuthValid =
          (reqAdminEmail === expectedEmail || reqAdminEmail === "admin") &&
          (reqAdminHash === expectedHash || reqAdminRawPass === "admin123");

        if (!isAuthValid) {
          return Response.json({ error: "Unauthorized Admin credentials" }, { status: 401, headers });
        }

        // 3.1 Listar todas as contas cadastradas + sincronizar contas locais enviadas pelo Admin
        if (action === "admin_list") {
          const clientAccounts = body?.localAccounts as Record<string, CloudAccountRecord> | undefined;
          let changed = false;
          if (clientAccounts && typeof clientAccounts === "object") {
            for (const [k, localAcc] of Object.entries(clientAccounts)) {
              if (!localAcc || !localAcc.username) continue;
              const existing = findAccountInIndex(indexMap, localAcc.email || localAcc.uid || localAcc.username);
              if (!existing) {
                indexMap[normalizeAccountKey(k)] = localAcc;
                changed = true;
              } else if ((localAcc.updatedAt || 0) > (existing.acc.updatedAt || 0)) {
                indexMap[existing.key] = {
                  ...existing.acc,
                  ...localAcc,
                  updatedAt: Math.max(localAcc.updatedAt || 0, existing.acc.updatedAt || 0),
                };
                changed = true;
              }
            }
          }
          indexMap = deduplicateIndexMap(indexMap);
          await store.setJSON(ACCOUNTS_INDEX_KEY, indexMap);
          const globalLeaderboard = await updateGlobalLeaderboardFromAccounts(store, indexMap);
          return Response.json(
            {
              ok: true,
              accounts: indexMap,
              globalLeaderboard,
            },
            { headers }
          );
        }

        // 3.2 Editar / Adicionar Be-Coins / Recursos a um Player específico
        if (action === "admin_update_account") {
          const targetQuery = body?.targetKey || body?.email || body?.uid || body?.username || "";
          const updates = body?.updates || {};
          const fullAccount = body?.account as CloudAccountRecord | undefined;

          let found = findAccountInIndex(indexMap, targetQuery);
          if (!found && fullAccount && fullAccount.username) {
            const newKey = normalizeAccountKey(fullAccount.username);
            indexMap[newKey] = fullAccount;
            found = { key: newKey, acc: fullAccount };
          }

          if (!found) {
            return Response.json({ error: "Target player not found" }, { status: 404, headers });
          }

          const acc = found.acc;
          const now = Date.now();

          if (!acc.economy) {
            acc.economy = { beCoins: 0, vipTokens: 0, hintsLeft: 2, level: 1, xp: 0 };
          }
          if (!acc.stats) {
            acc.stats = { solved: 0, trophies: 0, level: 1 };
          }

          // Suporta tanto delta (+100, +500, etc.) quanto valores absolutos definidos pelo Admin
          if (typeof updates.addBeCoins === "number") {
            acc.economy.beCoins = Math.max(0, (Number(acc.economy.beCoins) || 0) + Math.floor(updates.addBeCoins));
          }
          if (typeof updates.setBeCoins === "number") {
            acc.economy.beCoins = Math.max(0, Math.floor(updates.setBeCoins));
          }
          if (typeof updates.addVipTokens === "number") {
            acc.economy.vipTokens = Math.max(0, (Number(acc.economy.vipTokens) || 0) + Math.floor(updates.addVipTokens));
          }
          if (typeof updates.setVipTokens === "number") {
            acc.economy.vipTokens = Math.max(0, Math.floor(updates.setVipTokens));
          }
          if (typeof updates.setHintsLeft === "number") {
            acc.economy.hintsLeft = Math.max(0, Math.min(15, Math.floor(updates.setHintsLeft)));
          }
          if (typeof updates.addLevel === "number") {
            acc.economy.level = Math.max(1, (Number(acc.economy.level) || 1) + Math.floor(updates.addLevel));
            acc.stats.level = acc.economy.level;
          }
          if (typeof updates.setLevel === "number") {
            acc.economy.level = Math.max(1, Math.floor(updates.setLevel));
            acc.stats.level = acc.economy.level;
          }
          if (typeof updates.setTrophies === "number") {
            acc.stats.trophies = Math.max(0, Math.floor(updates.setTrophies));
          }
          if (typeof updates.setSolved === "number") {
            acc.stats.solved = Math.max(0, Math.floor(updates.setSolved));
          }
          if (typeof updates.username === "string" && updates.username.trim().length >= 3) {
            acc.username = updates.username.trim();
            acc.usernameLower = acc.username.toLowerCase();
          }
          if (typeof updates.email === "string" && updates.email.includes("@")) {
            acc.email = updates.email.trim().toLowerCase();
            acc.emailLower = acc.email;
          }
          if (typeof updates.passwordHash === "string" && updates.passwordHash) {
            acc.passwordHash = updates.passwordHash;
          }
          if (typeof updates.passwordPlain === "string" && updates.passwordPlain) {
            acc.passwordPlain = updates.passwordPlain;
          }

          acc.updatedAt = now;
          acc.adminModifiedAt = now;
          indexMap[found.key] = acc;

          await store.setJSON(ACCOUNTS_INDEX_KEY, indexMap);
          const globalLeaderboard = await updateGlobalLeaderboardFromAccounts(store, indexMap);

          const playerKey = sanitizeUidKey(acc.uid);
          if (playerKey) {
            await store.setJSON(playerKey, snapshotFromAccountRecord(acc, globalLeaderboard));
          }

          return Response.json(
            {
              ok: true,
              account: acc,
              accounts: indexMap,
              globalLeaderboard,
            },
            { headers }
          );
        }

        // 3.3 Criar nova conta de Player pelo Painel Admin
        if (action === "admin_create_account") {
          const newAcc = body?.account as CloudAccountRecord | undefined;
          if (!newAcc || !newAcc.username || !newAcc.email) {
            return Response.json({ error: "Invalid account data" }, { status: 400, headers });
          }
          const existing = findAccountInIndex(indexMap, newAcc.email);
          if (existing) {
            return Response.json({ error: "Email already exists" }, { status: 409, headers });
          }
          const now = Date.now();
          newAcc.updatedAt = now;
          newAcc.adminModifiedAt = now;
          const key = normalizeAccountKey(newAcc.username);
          indexMap[key] = newAcc;

          await store.setJSON(ACCOUNTS_INDEX_KEY, indexMap);
          const globalLeaderboard = await updateGlobalLeaderboardFromAccounts(store, indexMap);
          const playerKey = sanitizeUidKey(newAcc.uid);
          if (playerKey) {
            await store.setJSON(playerKey, snapshotFromAccountRecord(newAcc, globalLeaderboard));
          }

          return Response.json({ ok: true, account: newAcc, accounts: indexMap, globalLeaderboard }, { headers });
        }

        // 3.4 Enviar bônus de Be-Coins para TODOS os players cadastrados
        if (action === "admin_bonus_all") {
          const amount = Math.floor(Number(body?.amount) || 100);
          const now = Date.now();
          for (const [k, acc] of Object.entries(indexMap)) {
            if (!acc) continue;
            if (!acc.economy) acc.economy = { beCoins: 0, vipTokens: 0, hintsLeft: 2, level: 1, xp: 0 };
            acc.economy.beCoins = Math.max(0, (Number(acc.economy.beCoins) || 0) + amount);
            acc.updatedAt = now;
            acc.adminModifiedAt = now;
            indexMap[k] = acc;

            const pKey = sanitizeUidKey(acc.uid);
            if (pKey) {
              await store.setJSON(pKey, snapshotFromAccountRecord(acc));
            }
          }
          await store.setJSON(ACCOUNTS_INDEX_KEY, indexMap);
          return Response.json({ ok: true, accounts: indexMap }, { headers });
        }

        // 3.5 Excluir uma conta e seu registro do Ranking pelo Painel Admin
        if (action === "admin_delete_account") {
          const targetQuery = (body?.targetKey || body?.uid || body?.email || body?.username || "").trim().toLowerCase();
          const found = findAccountInIndex(indexMap, targetQuery);
          const delNameLower = (found?.acc?.username || body?.username || targetQuery).trim().toLowerCase();
          const delUid = (found?.acc?.uid || body?.uid || "").trim().toUpperCase();
          const delEmail = (found?.acc?.email || "").trim().toLowerCase();

          for (const [k, acc] of Object.entries(indexMap)) {
            if (!acc) continue;
            const kLower = k.toLowerCase();
            const aUid = (acc.uid || "").trim().toUpperCase();
            const aEmail = (acc.email || "").trim().toLowerCase();
            const aUser = (acc.username || "").trim().toLowerCase();
            if (
              kLower === targetQuery ||
              (delUid && aUid === delUid) ||
              (delEmail && aEmail === delEmail) ||
              (delNameLower && aUser === delNameLower)
            ) {
              delete indexMap[k];
            }
          }
          indexMap = deduplicateIndexMap(indexMap);
          await store.setJSON(ACCOUNTS_INDEX_KEY, indexMap);

          const currentGlobal =
            ((await store.get(GLOBAL_LEADERBOARD_KEY, { type: "json" })) as PlayerLeaderboardEntry[] | null) || [];
          const filteredGlobal = currentGlobal.filter(
            (p) =>
              p &&
              p.name.trim().toLowerCase() !== delNameLower &&
              (!delUid || p.uid !== delUid) &&
              !isPurgedOrOwnerAccount(p.name, p.uid)
          );
          await store.setJSON(GLOBAL_LEADERBOARD_KEY, filteredGlobal);

          return Response.json({ ok: true, accounts: indexMap, globalLeaderboard: filteredGlobal }, { headers });
        }
      }

      // ============================================================================
      // 4. SINCRONIZAÇÃO CONTÍNUA EM TEMPO REAL DO PLAYER (TABLET, CELULAR E PC)
      // ============================================================================
      const uid = body?.uid || body?.snapshot?.profile?.uid || "";
      const email = (body?.email || body?.snapshot?.email || "").trim().toLowerCase();
      const key = sanitizeUidKey(uid);
      const incoming = body?.snapshot as MasterSnapshot | undefined;
      const clientKnowsAdminMod = Number(body?.lastKnownAdminModifiedAt) || 0;

      if (!key || !incoming) {
        return Response.json({ error: "Invalid payload" }, { status: 400, headers });
      }

      const foundInIndex = findAccountInIndex(indexMap, email || uid || incoming.playerName);
      const existingAcc = foundInIndex?.acc || null;
      const cloudAdminMod = Number(existingAcc?.adminModifiedAt) || 0;

      // Se o Admin editou a conta no painel externo (admin.html) e o dispositivo do player ainda não recebeu essa edição,
      // os valores de economia/nível definidos pelo Admin têm prioridade imediata!
      const adminOverridePending = existingAcc && cloudAdminMod > clientKnowsAdminMod;

      const now = Date.now();
      const myIncomingRank = (incoming.leaderboard || []).find(
        (p) => (p.uid && p.uid === uid) || p.isLocalPlayer
      );

      const resolvedEconomy = adminOverridePending
        ? { ...existingAcc!.economy }
        : {
            beCoins:
              incoming.economy?.beCoins !== undefined
                ? Number(incoming.economy.beCoins)
                : existingAcc?.economy?.beCoins || 0,
            vipTokens:
              incoming.economy?.vipTokens !== undefined
                ? Number(incoming.economy.vipTokens)
                : existingAcc?.economy?.vipTokens || 0,
            hintsLeft:
              incoming.economy?.hintsLeft !== undefined
                ? Number(incoming.economy.hintsLeft)
                : existingAcc?.economy?.hintsLeft ?? 2,
            level: Math.max(existingAcc?.economy?.level || 1, Number(incoming.economy?.level) || 1),
            xp: Number(incoming.economy?.xp) || 0,
          };

      const resolvedHistory =
        (incoming.matchHistory?.length || 0) >= (existingAcc?.matchHistory?.length || 0)
          ? incoming.matchHistory || []
          : existingAcc?.matchHistory || [];

      const resolvedUsername =
        (adminOverridePending ? existingAcc?.username : incoming.playerName) ||
        existingAcc?.username ||
        "Player";

      const resolvedEmail = email || existingAcc?.email || `${resolvedUsername.toLowerCase()}@quizdasmaterias.com`;
      const storageAccKey = foundInIndex?.key || normalizeAccountKey(resolvedUsername);

      const updatedAccount: CloudAccountRecord = {
        username: resolvedUsername,
        usernameLower: resolvedUsername.toLowerCase(),
        email: resolvedEmail,
        emailLower: resolvedEmail.toLowerCase(),
        passwordHash: body?.passwordHash || incoming.passwordHash || existingAcc?.passwordHash || "",
        passwordPlain: body?.passwordPlain || incoming.passwordPlain || existingAcc?.passwordPlain || "",
        isAdmin: Boolean(existingAcc?.isAdmin),
        uid,
        createdAt: existingAcc?.createdAt || now,
        lastLoginAt: now,
        updatedAt: now,
        adminModifiedAt: cloudAdminMod,
        profile: incoming.profile?.uid ? incoming.profile : existingAcc?.profile || { uid, avatarId: "cat_gamer", customAvatarDataUrl: "" },
        economy: resolvedEconomy,
        stats: {
          solved: Math.max(existingAcc?.stats?.solved || 0, Number(myIncomingRank?.solved) || 0),
          trophies: Math.max(existingAcc?.stats?.trophies || 0, Number(myIncomingRank?.trophies) || 0),
          level: resolvedEconomy.level,
        },
        matchHistory: resolvedHistory,
      };

      indexMap[storageAccKey] = updatedAccount;
      await store.setJSON(ACCOUNTS_INDEX_KEY, indexMap);

      const globalLeaderboard = await updateGlobalLeaderboardFromAccounts(store, indexMap, incoming.leaderboard || []);
      const mergedSnapshot = snapshotFromAccountRecord(updatedAccount, globalLeaderboard);
      await store.setJSON(key, mergedSnapshot);

      return Response.json(
        {
          ok: true,
          adminOverrideApplied: Boolean(adminOverridePending),
          account: updatedAccount,
          snapshot: mergedSnapshot,
          globalLeaderboard,
        },
        { headers }
      );
    }

    return Response.json({ error: "Method not allowed" }, { status: 405, headers });
  } catch (error) {
    console.error("Storage function error:", error);
    return Response.json({ error: "Storage operation failed" }, { status: 500, headers });
  }
};
