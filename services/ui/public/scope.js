export function filterResources(resources, environment) {
  if (environment === 'all') return resources;
  const term = environment === 'production' ? 'prod' : 'staging';
  return resources.filter((resource) => resource.name.toLowerCase().includes(term));
}

export function workloadPrompt(resource, environment) {
  return `Investigate this real Azure workload over the last hour with ${environment} selected: ${resource}. Correlate application requests, exceptions and traces with the related same-environment Container App console/system logs, runtime metrics, and confirmed database metrics/logs. Use workload-check with --environment ${environment}. If App Insights is empty, follow the application host and its log workspace. Label shared dependencies and distinguish evidence, likely causes, and coverage gaps. Do not investigate unrelated environments.`;
}
