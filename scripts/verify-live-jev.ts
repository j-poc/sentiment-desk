// A previous version sent a fabricated observation to the paid Jev endpoint.
// Keep this command fail-closed until a rights-cleared real-source cohort,
// account-owner approval, and independent labels are available.
process.stderr.write(
  "BLOCKED: synthetic live-Jev smoke is disabled. Use the frozen real-source evaluator after account-use approval and independent labeling.\n",
);
process.exitCode = 2;
