// Dev-handoff migration: give every role a voice, and rewrite its RadiusAI angle
// to lead with the officer's win rather than the student's.
//
//   npm run roles:tone
//
// Why radius_angle needed rewriting at all: it is the per-role hook the Stage 4
// email is built from, and all eight rows were written student-first. The email
// inherited that framing no matter what the prompt said, because the contract it
// was handed already said "your students get...". These rewrites make the
// institution the subject and carry "free" into every one of them.

import { pool } from "../src/lib/db.js";
import { clearRoleCache } from "../src/lib/roleObjectives.js";

const ANGLES = {
  tpo_assistant: `You can give every student personalised, ATS-ready application support without adding to your workload or your budget, because RadiusAI is free to the university and to students. Even the students you cannot reach one to one get a professional application, and you see everyone's progress live.`,
  tpo_senior: `You get live visibility of every student's application progress across the batch, and even your weakest students become placement-ready, at no cost to your institution. Where the placement record is strong this can also become a revenue-sharing partnership, so the university is paid, not billed.`,
  faculty_tpo: `Your department can make every student placement-ready with professional, ATS-ready applications at no cost, and you can see each student's readiness and application status live. It works hardest for the students who need the most preparation, not only the strongest.`,
  placement_manager: `It has never been easier to level up every student's applications, including the ones with uneven readiness, and it costs your institution nothing. You get a live view of the whole cohort's applications, and qualifying institutions can earn a share of the revenue.`,
  career_services: `You can give every student across every discipline a standout, ATS-ready application for free and without more of your time, and see the whole cohort's progress live. It lifts the students who usually struggle to stand out, not just the polished ones.`,
  corporate_relations: `Every student you send to recruiters arrives with a professional, ATS-ready application, at no cost to the institution, which strengthens the calibre recruiters see from your students. You get live visibility of applications, and qualifying institutions can share revenue under a partnership.`,
  tpo: `It has never been easier to get every student placement-ready with professional, ATS-ready applications, and it costs your institution nothing. Even your weakest students get a strong application, and you track every student's applications live.`,
};
ANGLES.other = ANGLES.tpo;

// 'other' is academic on purpose: for an unknown senior, formal is the lower-risk
// voice. career_services is the judgement call — operational, because those teams
// are usually professional staff rather than faculty.
const ACADEMIC = ["faculty_tpo", "tpo_senior", "other"];
const OPERATIONAL = ["placement_manager", "corporate_relations", "tpo", "tpo_assistant", "career_services"];

const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query(`
    ALTER TABLE role_objectives
      ADD COLUMN IF NOT EXISTS tone_register TEXT NOT NULL DEFAULT 'academic'`);
  await client.query(`
    DO $$ BEGIN
      ALTER TABLE role_objectives ADD CONSTRAINT role_objectives_tone_register_check
        CHECK (tone_register IN ('academic','operational'));
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);

  await client.query(`UPDATE role_objectives SET tone_register='academic'    WHERE role_key = ANY($1)`, [ACADEMIC]);
  await client.query(`UPDATE role_objectives SET tone_register='operational' WHERE role_key = ANY($1)`, [OPERATIONAL]);

  for (const [key, angle] of Object.entries(ANGLES)) {
    await client.query(`UPDATE role_objectives SET radius_angle=$2 WHERE role_key=$1`, [key, angle]);
  }
  await client.query("COMMIT");
} catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }

clearRoleCache();
const { rows } = await pool.query(
  `SELECT role_key, tone_register, left(radius_angle, 58) angle FROM role_objectives
    WHERE is_active ORDER BY match_priority`);
console.table(rows);
await pool.end();
