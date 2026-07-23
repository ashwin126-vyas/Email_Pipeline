# RadiusAI Outreach Email Generation — Context File

Read this before touching anything in the outreach pipeline.

Implementation status is tracked at the bottom (§11).

---

## 0. Purpose

We generate cold outreach emails to placement officers at Indian institutions to sell
RadiusAI (AI CV/resume generation for students). Each email is built from two payloads:

- **Research data**: typed facts about one institution, produced by the Research API
- **Radius block**: static product/proof/offer content, one version per segment

**Hard rule: raw `research_notes` prose never enters the email prompt.**
Free text in, generic email out. The generator only ever sees typed fields plus one
extracted `hook_sentence`.

---

## 1. Pipeline

```
research_api
   ↓  (raw notes + scraped pages)
extract()            — LLM call #1, structured output only
   ↓
research_facts       — typed row, one per institution, with provenance
   ↓
derive()             — pure code, no LLM. Assigns segment, pain, proof, offer
   ↓
generate()           — LLM call #2. Input: research_facts + radius_block
   ↓
validate()           — pure code. Rejects on hallucinated numbers, length, forbidden phrases
   ↓
email_log
```

Two LLM calls, separated by deterministic code. Do not collapse them into one.

---

## 2. Research fields

Ranked by impact on reply rate. Build Tier 0 and Tier 1 before the first send.
Tier 2 improves conversion. Tier 3 is enrichment, add later.

### Tier 0 — Eligibility and routing (send is blocked if any are missing)

| Field | Type | Example | Role in the email |
|---|---|---|---|
| `institution_name` | str | "Birla Institute of Technology, Mesra" | Salutation, subject line |
| `is_valid_buyer` | bool | true | Kills non-buyers before they cost you a send |
| `invalid_reason` | str \| null | "training company, no placement cell" | Audit trail |
| `institution_type` | enum | `private_university` | Picks the template. See enum below |
| `campus_count` | int | 1 | Multi-campus means one sale covers many campuses |
| `program_mix` | enum | `engineering` | Pharmacy and management need different recruiter language |
| `annual_graduating_cohort` | int | 1200 | Sizes the pain and the price |
| `contact_name` | str | "Dr. A. Sharma" | No name means no email. Do not write "Dear Sir/Madam" |
| `contact_title` | str | "Training & Placement Officer" | Mirrored back in line 1 |
| `role_type` | enum | `tpo_head` | Decision maker vs coordinator changes the ask |
| `contact_email` | str | verified | Bounce rate is a deliverability risk |

`institution_type` enum:
`iit_nit_iiit` | `central_university` | `private_university` | `deemed_university` |
`autonomous_college` | `affiliated_college` | `multi_campus_group` | `polytechnic` | `non_academic`

`program_mix` enum:
`engineering` | `pharmacy` | `management` | `arts_science` | `design` | `mixed`

`role_type` enum:
`tpo_head` | `tpo_coordinator` | `dean_placements` | `director_principal` |
`corporate_relations` | `faculty` | `unknown`

### Tier 1 — The hook (single biggest driver of reply rate)

This is the paragraph that proves you are not blasting. Without it the email is dead.

| Field | Type | Example | Role in the email |
|---|---|---|---|
| `recent_event` | obj | see below | Opening line. Something that happened to them in the last 6 months |
| `placement_season_window` | str | "Aug 2026 - Dec 2026" | Supplies urgency without fake scarcity |
| `placement_cell_name` | str | "Corporate Relations Cell" | Use their internal vocabulary, not yours |
| `specificity_anchor` | str | "16,000+ alumni network" | One verifiable detail nobody else would cite |

```json
"recent_event": {
  "type": "mou_industry",
  "summary": "signed an MOU with Bajaj Auto Foundation",
  "date": "2026-03-14",
  "source_url": "https://..."
}
```

`recent_event.type` enum:
`mou_industry` | `new_ai_or_tech_centre` | `ranking_or_accreditation` |
`placement_drive_announcement` | `hackathon_or_workshop` | `new_program_launch` |
`leadership_change` | `milestone_anniversary` | `none_found`

If `recent_event.type == "none_found"`, fall back to `specificity_anchor`.
If both are missing, do not send. An email with no hook is worse than no email.

### Tier 2 — The pitch surface

| Field | Type | Example | Role in the email |
|---|---|---|---|
| `claimed_placement_rate` | obj `{value, year, source_url}` | `{92.0, 2025, "..."}` | The number they defend publicly. Attach the value prop here |
| `median_package_lpa` | float \| null | 6.5 | Signals recruiter tier and the ceiling |
| `highest_package_lpa` | float \| null | 44.0 | What they brag about, so what they want to protect |
| `top_recruiters` | list[str], max 5 | ["TCS", "Infosys", "Deloitte"] | Naming two proves you actually looked |
| `publishes_placement_report` | bool | true | If true, they care about reportable metrics |
| `placement_report_url` | str \| null | | Evidence for the audit offer |
| `existing_placement_tech` | str \| null | "Superset" | Do not pitch against a tool you did not know they had |
| `nirf_rank` | obj `{rank, category, year}` \| null | | Elite segment signal |
| `naac_grade` | str \| null | "A++" | Ties directly to the accreditation-reporting pain |
| `tech_focus_signals` | list[enum] | ["ai", "data_science"] | Lets you speak to their curriculum, not generic CV help |

`tech_focus_signals` enum: `ai` | `data_science` | `cyber_security` | `cloud` | `iot` | `robotics` | `none`

### Tier 3 — Enrichment (add after v1 sends)

`city`, `state`, `city_tier` (1/2/3), `founded_year`, `student_body_size`,
`alumni_network_size`, `website`, `linkedin_url`, `affiliating_university`,
`notable_awards`, `hiring_partner_count`.

### Provenance (required on every fact)

Every Tier 1 and Tier 2 fact carries:

```json
{ "value": "...", "source_url": "...", "fetched_at": "2026-07-23T15:04:33+05:30", "confidence": 0.0 }
```

The generator is instructed to cite **only** facts with `confidence >= 0.8`.
This is the mechanism that stops fabricated placement percentages reaching a real TPO.

---

## 3. Derived fields (computed in code, not by the LLM)

`derive()` runs after extraction and before generation. Deterministic, testable, logged.

| Field | Enum values | Rule |
|---|---|---|
| `segment_template` | `group`, `elite`, `private_uni`, `college`, `non_engineering` | `campus_count > 1` → group. `institution_type in (iit_nit_iiit, central_university)` or `nirf_rank <= 100` → elite. `program_mix not in (engineering, mixed)` → non_engineering. Else by type |
| `pain_hypothesis` | `ats_rejection`, `staff_bandwidth`, `unreported_cohort`, `tier2_recruiter_access`, `accreditation_reporting` | elite → ats_rejection. group or cohort > 2000 → staff_bandwidth. placement_rate < 70 → unreported_cohort. city_tier >= 2 → tier2_recruiter_access. naac_grade present and publishes_placement_report → accreditation_reporting |
| `proof_to_cite` | `es_london_pilot`, `ats_uplift_stat`, `dream2rank`, `free_audit_only` | Pick the one that survives scrutiny for that segment |
| `offer_variant` | `free_ats_audit_50`, `pilot_one_department`, `group_licence_call` | group → group_licence_call. Else free_ats_audit_50 |
| `hook_sentence` | str, max 25 words | Built from `recent_event.summary` or `specificity_anchor`. Must be traceable to a source_url |
| `deal_size_band` | `s`, `m`, `l`, `xl` | From `annual_graduating_cohort × campus_count` |

Personalisation comes from **structured selection**, not from the model improvising.
Five templates plus a varying hook produces genuine differentiation. Forty-nine free-form
prompts produces forty-nine identical emails.

---

## 4. Contract passed to the generator

```json
{
  "research": {
    "institution_name": "Poornima University",
    "institution_type": "private_university",
    "campus_count": 1,
    "program_mix": "engineering",
    "annual_graduating_cohort": 1400,
    "placement_cell_name": "Training & Placement Cell",
    "contact_name": "Dr. A. Sharma",
    "contact_title": "Head, Training & Placement",
    "role_type": "tpo_head",
    "claimed_placement_rate": { "value": 87.0, "year": 2025, "confidence": 0.92 },
    "top_recruiters": ["Infosys", "Wipro", "Deloitte"],
    "tech_focus_signals": ["ai", "data_science", "cyber_security"],
    "existing_placement_tech": null,
    "placement_season_window": "Aug 2026 - Dec 2026"
  },
  "derived": {
    "segment_template": "private_uni",
    "pain_hypothesis": "ats_rejection",
    "proof_to_cite": "ats_uplift_stat",
    "offer_variant": "free_ats_audit_50",
    "hook_sentence": "Poornima runs AI, Data Science and Cyber Security specialisations alongside a 16,000-strong alumni network."
  },
  "radius_block": { "...": "loaded by segment_template, see section 7" }
}
```

---

## 5. Extraction prompt (LLM call #1)

```
You extract structured facts about an educational institution from source material.

RULES
1. Output valid JSON only. No preamble, no markdown fences, no commentary.
2. Never infer, estimate, or fill a field from general knowledge. If the source
   material does not state it, output null.
3. Every Tier 1 and Tier 2 fact must carry source_url and confidence (0.0-1.0).
   confidence < 0.8 means the fact will not be used. That is the correct outcome
   for anything uncertain.
4. Numbers are the highest-risk field. A wrong placement percentage sent to the
   person who owns that number destroys the lead permanently. When a number is
   ambiguous, output null.
5. recent_event must be dated within the last 12 months and carry a source_url.
   If nothing qualifies, set type to "none_found".
6. specificity_anchor must be a single verifiable detail that would not appear in
   a description of a different institution. "Focuses on placements" fails this
   test. "16,000+ alumni across 40 countries" passes.
7. Set is_valid_buyer to false when the organisation has no student placement
   function (training companies, ed-tech vendors, consultancies) and state why.

SCHEMA
<paste the JSON schema from section 2>

SOURCE MATERIAL
<research_notes, scraped homepage, placement page, recent news>
```

## 6. Generation prompt (LLM call #2)

```
You write one cold outreach email from an early-stage founder to a placement
officer at an Indian institution.

INPUT
<the JSON contract from section 4>

RULES
1. 110 to 140 words in the body. Count them.
2. Open with the hook_sentence, rephrased naturally. Never open with "I hope this
   email finds you well", "I came across your institution", or any variant.
3. Line 2 names the pain from pain_hypothesis, framed as an observation about the
   category, not an accusation about them.
4. Cite ONLY facts present in the input with confidence >= 0.8. You may not
   introduce any number, percentage, statistic, client name or testimonial that
   is not in the input. If you want a number and do not have one, write the
   sentence without it.
5. Use placement_cell_name when referring to their team. Use their words.
6. One CTA, taken from offer_variant. Never a calendar link and a reply request
   in the same email. Never two questions.
7. No em-dashes. No exclamation marks. No "revolutionise", "cutting-edge",
   "leverage", "in today's competitive landscape", "game-changer".
8. Subject line: max 6 words, lowercase-ish, specific to this institution, no
   colons, no "Re:", no clickbait.
9. Sign off as the founder using the signature block in radius_block.

OUTPUT
{"subject": "...", "body": "...", "facts_cited": ["field_name", ...]}

facts_cited must list every input field you referenced. It is checked against the
body by code. Referencing a field you did not list, or listing one you did not
use, fails validation.
```

---

## 7. Radius block (static, five versions by `segment_template`)

Each version holds:

- `product_one_liner`: input to output in one sentence
- `value_props`: keyed by `pain_hypothesis`, one sentence each
  - `ats_rejection` — share of student CVs failing ATS parse before a human reads them, and the post-fix pass rate
  - `staff_bandwidth` — TPO hours saved per cohort
  - `unreported_cohort` — coverage for the students who currently get no CV help
  - `tier2_recruiter_access` — better-formed CVs travel further in off-campus applications
  - `accreditation_reporting` — reportable placement metrics for NAAC and NIRF submissions
- `proof`: keyed by `proof_to_cite`. Only claims that are true today
- `offer`: keyed by `offer_variant`
- `signature`: name, LBS affiliation, one line on why you built it
- `constraints`: word cap, forbidden phrases, PII handling line

**Honesty note for whoever writes this block.** The European School of Economics
London pilot does not travel to a TPO in Jhansi. Do not stretch it. The strongest
asset you can add this week is a measured before/after ATS pass rate on real Indian
student CVs. Until that exists, the free audit offer is carrying the email, so make
the offer concrete: 50 CVs from their most recent batch, returned as a named report.

---

## 8. Validation gates (pure code, runs on every generated email)

Fail closed. A blocked email costs nothing. A bad one costs the lead.

| Gate | Rule |
|---|---|
| `no_orphan_numbers` | Every digit sequence in the body maps to a value in the input contract |
| `facts_cited_match` | Each field in `facts_cited` appears in the body and exists in the input |
| `word_count` | 110 to 140 |
| `banned_phrases` | Reject on the section 6 list plus any em-dash |
| `hook_present` | First sentence overlaps `hook_sentence` by at least 3 content words |
| `single_cta` | Exactly one question mark or one link, not both |
| `name_present` | `contact_name` appears, and it is not "Sir/Madam" |
| `confidence_floor` | No cited fact has confidence < 0.8 |
| `dedupe` | Cosine similarity against the last 50 sent bodies is below 0.85 |

The dedupe gate is the one that tells you whether personalisation is real. If it
starts firing, the hook fields are too thin and the fix belongs in extraction,
not in the generation prompt.

---

## 9. Data integrity rules for `company_campaigns`

Current bugs in the seeded table, fix these first:

1. `research_done = true` is being set independently of `research_notes` (C-DAC has
   the flag and no notes). Make `research_done` a computed property: true only when
   `research_facts` exists and passes the Tier 0 completeness check.
2. `campaign_status = completed` is being set with `email_generated_count = 0`.
   Status must be derived from `email_log`, never written directly.
3. `total_employees = 1` on 48 of 49 rows. Contacts belong in their own table, one
   row per person, joined at generation time. The per-contact branch of the design
   has no data to run on until this is fixed.
4. Split `company_campaigns` into `companies` (static), `research_facts` (versioned,
   refreshable), `contacts` (per-person), `campaigns` (per send).

---

## 10. Build order

1. `research_facts` table plus Tier 0 and Tier 1 fields
2. `extract()` on the 27 existing research notes, then backfill the 22 missing
3. `contacts` table, load real people
4. `derive()` with unit tests on the routing rules
5. `radius_block` for `group` and `private_uni` only
6. `generate()` plus `validate()`
7. Send to the 7 multi-campus groups first. One reply there is worth more than
   forty-two cold sends, and you learn before burning the rest of the list

---

## 11. Implementation status (2026-07-23)

| Step | State | Where |
|---|---|---|
| 1. `research_facts` table | **done** — Tier 0/1/2 + provenance, versioned | `schema.sql` |
| 2. `extract()` over existing notes | **done** — 27 companies, 2 non-buyers caught | `src/lib/extractFacts.js`, `npm run facts:extract` |
| 3. per-person contacts table | **already existed** — `company_contacts`, 50 people | `scripts/sync-companies.mjs` |
| 4. `derive()` + unit tests | **done** — 21 tests | `src/lib/derive.js`, `npm run test:derive` |
| 5. `radius_block` | **not started** | — |
| 6. `generate()` + `validate()` | **not started** | — |
| 7. send to groups first | blocked on 5 and 6 | — |

### Corrections to §9 found when checking against the live database

- §9.1 and §9.2 were both real, and both traced to the **same single row**
  (C-DAC), hand-set as a demo value. Both are now derived and cannot be
  hand-written: `research_done` by the `research_facts_sync` trigger,
  `campaign_status` inside `refresh_campaign_email_stats`.
- §9.3 `total_employees = 1` on 48/49 is **correct data, not a bug** — only one
  company in the list has two contacts. The per-contact branch runs fine; the
  list is simply mostly one-person-per-institution.
- §9.4 is **already satisfied**: `companies` (static), `company_contacts`
  (per-person), `company_campaigns` (per send) all exist. `research_facts` was
  the only missing table.
- §10.2 says "backfill the 22 missing" — 13 of those have no `website_url` at
  all, so they need a source other than their own site.
- §10.7 says 7 multi-campus groups; extraction found **2** (`Techno India Group`,
  `JIS Group`). `campus_count` is almost never stated on a homepage, so this
  needs a targeted source before the group segment is worth prioritising.
