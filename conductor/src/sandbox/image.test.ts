import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { dockerAvailable, requireDocker } from "../test-support/docker.js";
import { buildImage, imageId } from "./image.js";

// A home registers its Scripts on the image id behind `aliquot-sandbox:<short
// sha>`. Docker's containerd store gives every build a new id and drops the
// image a re-pointed tag held, so a second build under the same tag must reuse
// the image, not replace it. This process's tag is its own, as in every
// Docker suite.
const TAG = `aliquot-sandbox:image-${process.pid}`;

const suite = dockerAvailable
	? "Sandbox image (Docker)"
	: "Sandbox image: SKIPPED because `docker info` failed; start Docker to run these";

describe.skipIf(!requireDocker())(suite, () => {
	afterAll(() => {
		spawnSync("docker", ["rmi", TAG], { stdio: "ignore" });
	});

	it("a second build under a tag keeps the image a home registered on", async () => {
		const registered = await buildImage({ tag: TAG });

		const again = await buildImage({ tag: TAG });

		expect(imageId(`sha256:${registered.id}`)).toBe(registered.id);
		expect(again).toEqual(registered);
	}, 600_000);
});
