// Turns a campaign's target_filter JSON into a safe, parameterized SQL WHERE
// fragment over the `contacts` table. Only a fixed allow-list of keys is
// honored, and every value is bound as a parameter (never interpolated) so a
// stored filter can't inject SQL.
//
// Supported keys (all optional):
//   title_ilike, company_ilike, industry_ilike, name_ilike, email_ilike
//     -> ILIKE '%value%' on that column
//   apollo_ids: string[]   -> restrict to these apollo_id values
//
// Always AND-ed with the same "usable email" guard the manual send path uses.

const ILIKE_COLUMNS = {
  title_ilike: "title",
  company_ilike: "company",
  industry_ilike: "industry",
  name_ilike: "name",
  email_ilike: "email",
};

// Returns { where, values } where `where` is a full boolean expression (no
// leading WHERE) and values are the bind params starting at $startIndex.
export function buildContactWhere(filter, startIndex = 1) {
  const clauses = [
    "email IS NOT NULL",
    "email <> ''",
    "email NOT ILIKE '%not_unlocked%'",
  ];
  const values = [];
  let i = startIndex;

  const f = filter && typeof filter === "object" ? filter : {};

  for (const [key, column] of Object.entries(ILIKE_COLUMNS)) {
    const raw = f[key];
    if (typeof raw === "string" && raw.trim()) {
      clauses.push(`${column} ILIKE $${i}`);
      values.push(`%${raw.trim()}%`);
      i += 1;
    }
  }

  if (Array.isArray(f.apollo_ids) && f.apollo_ids.length) {
    clauses.push(`apollo_id = ANY($${i})`);
    values.push(f.apollo_ids.map(String));
    i += 1;
  }

  return { where: clauses.join(" AND "), values, nextIndex: i };
}
