# Gathered: Postgres spike (45-minute timebox)
Pass/fail table and results: [`docs/Gathered - Data Model & Architecture.md`](../docs/Gathered%20-%20Data%20Model%20%26%20Architecture.md) §10.1.

**Walt does (needs sign-in or passwords):**
1. In Databricks, create a Lakebase project (P1). Note whether Free Edition allows it.
2. Create a role `gathered_app` with a password **you choose**. Look for "native Postgres role" or password login, not an OAuth token (P2).
3. Open the Lakebase SQL editor as the owner and run `rls_test.sql`.
4. On your PC: `npm install pg`, set `DATABASE_URL` for `gathered_app`, then run `node pgtest.mjs pg`. Wait about 10 minutes idle and run it again to test cold start (P4).
5. Optional P6: create a personal access token and run `node pgtest.mjs dbsql`.
6. Paste the output into chat. **Don't paste passwords or tokens.**

**If P1, P2 or P3 fails:** create a free Neon database from Vercel's Storage tab, then repeat steps 3–4 against it.

**Never commit secrets.** `.env*` is git-ignored.
