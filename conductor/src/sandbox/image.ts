import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Sha256 } from "../ids.js";

/** The repository's `sandbox/` directory: the image's build context. */
export const sandboxRoot = fileURLToPath(
	new URL("../../../sandbox/", import.meta.url),
);

/** Where the repository keeps Scripts, one directory per Script name. */
export const scriptsRoot = fileURLToPath(
	new URL("../../../sandbox/scripts/", import.meta.url),
);

/** `aliquot-sandbox:<short git sha>`, or `aliquot-sandbox:dev` outside git. */
export const defaultImageTag = (): string => {
	const git = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
		cwd: sandboxRoot,
		encoding: "utf8",
	});
	const sha = git.status === 0 ? git.stdout.trim() : "";
	return `aliquot-sandbox:${sha || "dev"}`;
};

/**
 * The image's local `Id` (the sha256 of its config), or undefined when Docker
 * has no such image. A local build has no registry digest (`RepoDigests` is
 * empty), so the Id is what a Script registration records as `image_digest`.
 */
export const imageId = (ref: string): Sha256 | undefined => {
	const inspect = spawnSync(
		"docker",
		["image", "inspect", "--format", "{{.Id}}", ref],
		{ encoding: "utf8" },
	);
	if (inspect.status !== 0) return undefined;
	return Sha256.parse(inspect.stdout.trim().replace(/^sha256:/, ""));
};

/**
 * The Sandbox image under `tag`: the one Docker already has, else a `docker
 * build` of `sandbox/Dockerfile`. A build gives the tag a new id and Docker
 * drops the image the tag held, which would take the image a home's Scripts
 * are registered on out from under its Runs, so an existing tag is kept. To
 * rebuild a tag, `docker rmi` it first.
 */
export const buildImage = async ({
	tag = defaultImageTag(),
	onOutput,
}: {
	tag?: string;
	onOutput?: (chunk: Buffer) => void;
} = {}): Promise<{ tag: string; id: Sha256 }> => {
	const existing = imageId(tag);
	if (existing) return { tag, id: existing };
	const output: Buffer[] = [];
	const code = await new Promise<number | null>((resolve, reject) => {
		const child = spawn(
			"docker",
			["build", "-f", `${sandboxRoot}Dockerfile`, "-t", tag, sandboxRoot],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		const collect = (chunk: Buffer) => {
			output.push(chunk);
			onOutput?.(chunk);
		};
		child.stdout.on("data", collect);
		child.stderr.on("data", collect);
		child.on("error", reject);
		child.on("close", resolve);
	});
	if (code !== 0) {
		throw new Error(
			`docker build exited ${code}:\n${Buffer.concat(output).toString("utf8").slice(-4000)}`,
		);
	}
	const id = imageId(tag);
	if (!id) throw new Error(`docker build succeeded but ${tag} is missing`);
	return { tag, id };
};
