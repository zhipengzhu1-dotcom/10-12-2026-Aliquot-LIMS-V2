import { spawnSync } from "node:child_process";

/** True when `docker info` succeeds, so the Docker-backed suites can run. */
export const dockerAvailable =
	spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;

/**
 * Whether a Docker-backed suite runs. Off CI a missing Docker skips the
 * suite; under CI it throws, so the suite fails rather than skipping unseen.
 */
export const requireDocker = (): boolean => {
	if (!dockerAvailable && process.env.CI) {
		throw new Error(
			"CI is set but `docker info` failed: the Docker-backed suites cannot run, so they fail instead of skipping",
		);
	}
	return dockerAvailable;
};
