// Every user-visible name of the tool lives here, so a rename touches this file and package.json only.
export const Brand = {
  name: "nightshift",
  configFile: "nightshift.json",
  stateDir: ".nightshift",
  ticketsDir: ".tickets",
  labelPrefix: "nightshift:",
  branchPrefix: "nightshift/",
  envPrefix: "NIGHTSHIFT_",
} as const;
