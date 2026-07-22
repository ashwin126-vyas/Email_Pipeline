// Friendly hint when an automation table is missing (setup not run yet).
export function automationHint(e) {
  return /relation .*(sequences|sequence_steps|campaigns|enrollments|suppressions).* does not exist/i.test(
    e.message
  )
    ? "Automation tables are missing. Run `npm run db:setup` to apply schema.sql."
    : e.message;
}
