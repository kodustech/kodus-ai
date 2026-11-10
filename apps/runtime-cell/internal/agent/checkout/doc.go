// Package checkout is what the cell reads from and writes into a claim's
// checkout before anything boots: the recipe of the default branch laid over
// the checkout's copy, the build files Kody wrote, and what the checkout pins
// for the mirror (go.sum modules, Dockerfile images).
//
// A Run's checkout is the PR's, so nothing here follows a link or replaces an
// entry it did not create; every function says how it holds that. It has no
// claim state and returns plain errors: the agent turns them into blockers.
package checkout
