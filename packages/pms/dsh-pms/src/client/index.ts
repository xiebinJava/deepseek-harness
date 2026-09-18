/**
 * The PMS integration is Host-owned. This empty Client face only satisfies
 * DSH's split-package build contract; PMS UI synchronization is exposed by
 * the generated `./remote` contribution and mounted by `dsh-api-remotes`.
 */
export function apply(): void {}
