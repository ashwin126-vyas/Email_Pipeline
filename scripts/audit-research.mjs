// Audit the quality of the research data. Read-only — reports, changes nothing.
//
//   npm run research:audit
//
// The pipeline can only be as good as the facts under it. This script looks for
// the failure modes that actually matter: facts asserted without a source, hooks
// that are not really hooks, and "contacts" that are not people.

import { pool } from "../src/lib/db.js";
import { isPersonName, nameProblem } from "../src/lib/personName.js";

const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : "—");
const line = (s) => console.log(s);

try {
  const { rows: facts } = await pool.query(
    `SELECT rf.*, cc.person, cc.title, cc.email, cc.website_url
       FROM research_facts rf
       LEFT JOIN LATERAL (SELECT * FROM company_contacts c
                           WHERE c.company_id = rf.company_id ORDER BY c.id LIMIT 1) cc ON true
      WHERE rf.is_current ORDER BY rf.company_id`
  );
  const n = facts.length;

  line(`\n══ RESEARCH QUALITY AUDIT — ${n} institutions ══\n`);

  // 1. Sourcing. A confidence score with no source_url is an opinion, not evidence.
  let sourced = 0, citableUnsourced = 0;
  for (const f of facts) {
    const prov = f.provenance || {};
    const entries = Object.entries(prov);
    if (entries.some(([, v]) => v?.source_url)) sourced++;
    citableUnsourced += entries.filter(([, v]) => !v?.source_url && Number(v?.confidence) >= 0.8).length;
  }
  line(`1. SOURCING`);
  line(`   rows with at least one source_url : ${sourced}/${n}  (${pct(sourced, n)})`);
  line(`   facts marked citable (>=0.8) with NO source_url : ${citableUnsourced}`);
  line(`   -> a confidence score without a source is an assertion, not evidence.\n`);

  // 2. Hooks. §2 requires recent_event to be dated within 12 months AND sourced.
  const evented = facts.filter((f) => f.recent_event?.type && f.recent_event.type !== "none_found");
  const datedEvents = evented.filter((f) => f.recent_event?.date);
  const sourcedEvents = evented.filter((f) => f.recent_event?.source_url);
  const anchorOnly = facts.filter(
    (f) => (!f.recent_event?.type || f.recent_event.type === "none_found") && f.specificity_anchor
  );
  const noHook = facts.filter(
    (f) => (!f.recent_event?.type || f.recent_event.type === "none_found") && !f.specificity_anchor
  );
  line(`2. HOOKS`);
  line(`   claimed a recent_event        : ${evented.length}/${n}`);
  line(`   ...of those, carrying a DATE  : ${datedEvents.length}   <- §2 requires one`);
  line(`   ...of those, carrying a SOURCE: ${sourcedEvents.length}   <- §2 requires one`);
  line(`   falling back to an anchor     : ${anchorOnly.length}`);
  line(`   no hook at all                : ${noHook.length}`);
  line(`   -> an undated, unsourced "event" should have been none_found.\n`);

  // 3. Are the anchors actually specific? "Focuses on placements" fails; a
  //    verifiable, institution-unique detail passes.
  line(`3. ANCHOR SPECIFICITY (the fallback hook for ${anchorOnly.length} institutions)`);
  const vague = [];
  for (const f of facts) {
    const a = f.specificity_anchor;
    if (!a) continue;
    const hasNumber = /\d/.test(a);
    const hasProperNoun = /\b[A-Z][a-z]{2,}/.test(a.replace(/^[A-Z][a-z]+\s/, ""));
    if (!hasNumber && !hasProperNoun) vague.push([f.institution_name, a]);
  }
  line(`   anchors with no number and no proper noun : ${vague.length}`);
  for (const [inst, a] of vague.slice(0, 6)) line(`     · ${(inst || "").slice(0, 28).padEnd(28)} "${a.slice(0, 54)}"`);
  line("");

  // 4. Contacts. "No name means no email" — but only if it IS a name.
  const { rows: contacts } = await pool.query(`SELECT id, person, title, email FROM company_contacts ORDER BY id`);
  const notPeople = contacts.filter((c) => !isPersonName(c.person));
  line(`4. CONTACT IDENTITY`);
  line(`   contacts total          : ${contacts.length}`);
  line(`   NOT a person's name     : ${notPeople.length}  (${pct(notPeople.length, contacts.length)})`);
  for (const c of notPeople) {
    line(`     ✗ ${(c.person || "(blank)").padEnd(20)} ${nameProblem(c.person).padEnd(26)} ${c.email}`);
  }
  line(`   -> writing "Dear Placement Ssce," is worse than not sending.\n`);

  // 5. Thin extraction: how much of the pitch surface actually got filled?
  const filled = (col) => facts.filter((f) => f[col] != null && (!Array.isArray(f[col]) || f[col].length)).length;
  line(`5. FIELD COVERAGE`);
  for (const col of ["campus_count", "annual_graduating_cohort", "claimed_placement_rate",
                     "top_recruiters", "naac_grade", "nirf_rank", "placement_cell_name",
                     "median_package_lpa", "publishes_placement_report"]) {
    const c = filled(col);
    line(`   ${col.padEnd(28)} ${String(c).padStart(3)}/${n}  ${pct(c, n)}`);
  }
  line(`   -> low numbers here are mostly honest: claimed_placement_rate stays near`);
  line(`      zero because per-department tables are rejected, not averaged.\n`);

  // 6. Coverage of the list as a whole.
  const { rows: cov } = await pool.query(
    `SELECT count(*)::int companies,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM company_contacts cc
              WHERE cc.company_id = co.id AND btrim(COALESCE(cc.website_url,'')) <> ''))::int with_site
       FROM companies co`
  );
  line(`6. LIST COVERAGE`);
  line(`   companies                    : ${cov[0].companies}`);
  line(`   with a website to research   : ${cov[0].with_site}`);
  line(`   with current research_facts  : ${n}`);
  line("");
} catch (e) {
  console.error("Audit failed:", e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
