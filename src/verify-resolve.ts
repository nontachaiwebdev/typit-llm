import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { resolveAllowedSources } from "./permissions.js";

// Known admin user from the main project's file_permissions (direct grants + group).
const ADMIN = "6d8d799a-9663-44f6-b2bc-4ef3bdff79a0";
// User who belongs to a group but has NO direct file_permissions rows — access
// comes purely from group-level grants. Before group support this resolved to 0.
const GROUP_ONLY_USER = "d74163d0-e437-4362-b12f-0380515b1f66";

async function main() {
  // 1. Exercise the real production helper against the main project.
  const mainCfg = {
    supabaseUrl: process.env.SUPABASE_URL!,
    supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
  };
  const sources = await resolveAllowedSources(ADMIN, mainCfg);
  console.log(`[main] resolveAllowedSources(admin, direct+group) → ${sources.length} allowed source paths`);
  for (const s of sources.slice(0, 5)) console.log(`   • ${s}`);

  // 1b. Group-only user: no direct grants, files come via group membership.
  //     This is the core proof of group support — expected > 0.
  const groupOnly = await resolveAllowedSources(GROUP_ONLY_USER, mainCfg);
  console.log(
    `[main] resolveAllowedSources(group-only user) → ${groupOnly.length} ` +
      `(expected > 0; was 0 before group support)`
  );
  for (const s of groupOnly.slice(0, 5)) console.log(`   • ${s}`);
  if (groupOnly.length === 0) {
    console.log("   ❌ group-only user resolved to 0 — group grants are NOT being applied.");
  } else if (groupOnly.length > sources.length) {
    console.log("   ⚠️  group-only user sees more than admin — unexpected.");
  }

  // 2. Fail-closed check: a random/unknown user (no grants, no groups) gets nothing.
  const none = await resolveAllowedSources("00000000-0000-0000-0000-000000000000", mainCfg);
  console.log(`[main] resolveAllowedSources(unknown user) → ${none.length} (expected 0)`);

  // 3. Pre-flight: does the BOENDE project have a file_permissions table?
  const boendeUrl = process.env.SUPABASE_URL_BOENDE;
  const boendeKey = process.env.SUPABASE_SERVICE_ROLE_KEY_BOENDE;
  if (!boendeUrl || !boendeKey) {
    console.log("[boende] env not set — skipping");
    return;
  }
  const boende = createClient(boendeUrl, boendeKey);
  const { count, error } = await boende
    .from("file_permissions")
    .select("*", { count: "exact", head: true });
  if (error) {
    console.log(`[boende] file_permissions NOT usable: ${error.message}`);
    console.log("          → boende chat will fail closed (deny all) until this table exists + is populated.");
  } else {
    console.log(`[boende] file_permissions exists — ${count ?? 0} row(s).`);
  }

  // Pre-flight the group_members table too. If it's missing, group grants are
  // silently skipped (resolveAllowedSources degrades to user-only) rather than erroring.
  const { count: gmCount, error: gmError } = await boende
    .from("group_members")
    .select("*", { count: "exact", head: true });
  if (gmError) {
    console.log(`[boende] group_members NOT usable: ${gmError.message}`);
    console.log("          → boende chat resolves user-only grants until this table exists.");
  } else {
    console.log(`[boende] group_members exists — ${gmCount ?? 0} row(s).`);
  }
}

main().catch((err) => {
  console.error("verify-resolve failed:", err.message ?? err);
  process.exit(1);
});
