// Refresh the `companies` table from `contacts` (which is read-only, owned by
// the sibling apollo-people-app). One row per distinct company, with a live
// count of how many usable contacts belong to it.
//
//   npm run companies:sync
//
// Safe to re-run: upserts by lower(name), so counts stay current as contacts
// are added or removed. Companies that no longer have any contact are kept with
// contact_count = 0 (delete them yourself if you want them gone).

import { pool } from "../src/lib/db.js";

const USABLE = `ct.email IS NOT NULL AND ct.email <> '' AND ct.email NOT ILIKE '%not_unlocked%'`;

try {
  // 1. Upsert every distinct company + its contact count.
  const upsert = await pool.query(
    `INSERT INTO companies (name, contact_count)
     SELECT btrim(ct.company), count(*)::int
       FROM contacts ct
      WHERE ct.company IS NOT NULL AND btrim(ct.company) <> ''
        AND ${USABLE}
      GROUP BY btrim(ct.company)
     ON CONFLICT (lower(name))
     DO UPDATE SET contact_count = EXCLUDED.contact_count, updated_at = now()`
  );

  // 2. Zero out companies that no longer have any matching contact.
  const stale = await pool.query(
    `UPDATE companies co
        SET contact_count = 0, updated_at = now()
      WHERE co.contact_count <> 0
        AND NOT EXISTS (
          SELECT 1 FROM contacts ct
           WHERE lower(btrim(ct.company)) = lower(co.name) AND ${USABLE})`
  );

  // 3. Rebuild the people rows (one row per person, carrying their company).
  //    Fully derived from `contacts`, so a clean rebuild is simplest + correct.
  await pool.query(`TRUNCATE company_contacts RESTART IDENTITY`);
  const people = await pool.query(
    `INSERT INTO company_contacts
       (company_id, company, person, title, email,
        person_phone, org_phone, linkedin, industry, website_url)
     SELECT co.id, co.name, ct.name, ct.title, ct.email,
            ct.person_phone, ct.org_phone, ct.linkedin, ct.industry, ct.website_url
       FROM companies co
       JOIN contacts ct ON lower(btrim(ct.company)) = lower(co.name)
      WHERE ${USABLE}
      -- insert in company order so the SERIAL ids (and the table's natural
      -- read order) ascend by company_id, keeping each company's people together
      ORDER BY co.id, ct.name
     ON CONFLICT (company_id, email) DO NOTHING`
  );

  // 4. Seed/refresh the campaign tracker. Only the DERIVED fields are updated —
  //    campaign_status / research_done / notes are yours and never overwritten.
  const trackers = await pool.query(
    `INSERT INTO company_campaigns (company_id, company, unique_job_titles)
     SELECT co.id, co.name,
            count(DISTINCT NULLIF(btrim(cc.title), ''))::int
       FROM companies co
       LEFT JOIN company_contacts cc ON cc.company_id = co.id
      GROUP BY co.id, co.name
     ON CONFLICT (company_id, campaign_version)
     DO UPDATE SET company = EXCLUDED.company,
                   unique_job_titles = EXCLUDED.unique_job_titles,
                   updated_at = now()`
  );

  // 5. One asset row per distinct job title at each company (adds new titles,
  //    leaves existing asset_created / email_log_id alone).
  const assets = await pool.query(
    `INSERT INTO campaign_assets (company_campaign_id, company_id, job_title)
     SELECT DISTINCT cam.id, cc.company_id, btrim(cc.title)
       FROM company_contacts cc
       JOIN company_campaigns cam ON cam.company_id = cc.company_id
      WHERE btrim(COALESCE(cc.title, '')) <> ''
     ON CONFLICT (company_campaign_id, job_title) DO NOTHING`
  );

  const { rows: summary } = await pool.query(
    `SELECT count(*)::int AS companies,
            coalesce(sum(contact_count),0)::int AS contacts,
            count(*) FILTER (WHERE contact_count > 1)::int AS multi
       FROM companies`
  );
  const s = summary[0];
  console.log(`Synced ${upsert.rowCount} company row(s); ${stale.rowCount} marked empty.`);
  console.log(`Rebuilt company_contacts: ${people.rowCount} people row(s).`);
  console.log(`Campaign trackers: ${trackers.rowCount} | new asset rows: ${assets.rowCount}`);
  console.log(`companies: ${s.companies} | contacts covered: ${s.contacts} | with 2+ people: ${s.multi}`);
} catch (e) {
  console.error("Sync failed:", e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
