#!/usr/bin/env node
import { exec } from "child_process";
import cac from "cac";
import tmp from "tmp";
import path from "path";
import fs from "fs";
import chokidar from "chokidar";
// @ts-ignore
import serialize from "serialize-to-js";
import audiosprite from "audiosprite";
import { AsepriteData, Rect } from "./aseprite-data";

const audioRegex = /\.(wav|mp3|webm|ogg|flac|aac|webm)$/;
const asepriteRegex = /\.(ase|aseprite)$/;

function isAudioFile(filename: string) {
  return audioRegex.test(filename);
}

function isAsepriteFile(filename: string) {
  return asepriteRegex.test(filename);
}

const cli = cac("pota-8");

cli
  .command(
    "bundle-assets [...paths]",
    "Bundle .aseprite files into a spritesheet, and audio files into an audiosprite"
  )
  .option("-o, --out-dir", "Directory to output to", { default: "asset-bundles" })
  .option("-w, --watch", "Build on changes")
  .option("--no-sounds", "Ignore audio files")
  .option("--no-aseprite", "Ignore .aseprite files")
  .option("-a, --aseprite [path]", "Path to Aseprite binary (leave blank to skip)", {
    default: process.env["ASEPRITE"] || false
  })
  .action(watch);

cli.help();
cli.parse(process.argv);

function watch(paths: string[], options: Record<string, any>) {
  const watcher = chokidar.watch(paths);

  let files: string[] = [];
  let isReady = false;
  let isBuilding = false;
  let shouldRebuild = false;

  const rebuild = async () => {
    if (isBuilding) {
      shouldRebuild = true;
    } else {
      isBuilding = true;
      shouldRebuild = false;
      console.log("Build build build...");

      try {
        await bundleAssets(files, options);
      } catch (err) {
        console.error(`\nError during build:\n${err.stack || err}`);
      }

      isBuilding = false;
      console.log("done");

      if (!options.watch) {
        watcher.close();
      }

      if (shouldRebuild) {
        rebuild();
      }
    }
  };

  const isOutputFile = (path: string) => path.includes(options.outDir);

  watcher.on("add", file => {
    file = path.resolve(file);

    if ((isAsepriteFile(file) || isAudioFile(file)) && !isOutputFile(file)) {
      if (isReady) {
        console.log(`Wow, new file: ${file}`);
        rebuild();
      }

      files.push(file);
    }
  });

  watcher.on("change", file => {
    file = path.resolve(file);

    if (isReady && files.includes(file)) {
      console.log(`Oh hey, changed file: ${file}`);
      rebuild();
    }
  });

  watcher.on("unlink", file => {
    file = path.resolve(file);

    if (isReady && files.includes(file)) {
      console.log(`Well shit, deleted file: ${file}`);
      files.splice(files.indexOf(file), 1);
      rebuild();
    }
  });

  watcher.on("ready", async () => {
    isReady = true;
    rebuild();

    if (!options.watch) {
      await watcher.close();
    }
  });
}

async function bundleAssets(files: string[], options: Record<string, any>) {
  if (!fs.existsSync(options.outDir)) {
    fs.mkdirSync(options.outDir);
  }

  const promises: Promise<any>[] = [];
  const asepriteFiles = files.filter(isAsepriteFile);
  const audioFiles = files.filter(isAudioFile);

  if (options.aseprite && asepriteFiles.length) {
    promises.push(handleAsepriteFiles(options.aseprite, asepriteFiles, options.outDir));
  }

  if (options.sounds && audioFiles.length) {
    promises.push(handleSoundFiles(audioFiles, options.outDir));
  }

  let context = {};
  for (let result of await Promise.all(promises)) {
    context = { ...context, ...result };
  }

  const indexJs = writeIndexJs(options.outDir, context);
  fs.writeFileSync(path.join(options.outDir, "index.js"), indexJs);
}

function writeIndexJs(
  outDir: string,
  { sprites, spritesheetPath, sounds, audiospritePath }: any
) {
  let result = "";

  if (spritesheetPath) {
    spritesheetPath = `./${path.relative(outDir, spritesheetPath)}`;
    result += `export { default as spritesheet } from '${spritesheetPath}';\n`;
  }

  if (audiospritePath) {
    audiospritePath = `./${path.relative(outDir, audiospritePath)}`;
    result += `export { default as audiosprite } from '${audiospritePath}';\n`;
  }

  if (sprites) {
    result += `\nexport const sprites = ${serialize(sprites)};\n`;
  }

  if (sounds) {
    result += `\nexport const sounds = ${serialize(sounds)};\n`;
  }

  return result;
}

function execAseprite(asepritePath: string, files: string[], sheetFilename: string) {
  return new Promise<AsepriteData>((resolve, reject) => {
    tmp.file((err, dataFilename, _, cleanup) => {
      if (err) return reject(err);

      const filesArgs = files.join(" ");

      // build command (see: https://www.aseprite.org/docs/cli/)
      const command = `${asepritePath} -b ${filesArgs} --sheet ${sheetFilename} --data ${dataFilename}`;

      exec(command, err => {
        if (err) return reject(err);

        // read and then delete the generated JSON
        fs.readFile(dataFilename, "utf-8", (err, data) => {
          if (err) return reject(err);
          cleanup();

          const spriteData: AsepriteData = JSON.parse(data);
          resolve(spriteData);
        });
      });
    });
  });
}

async function handleAsepriteFiles(
  asepritePath: string,
  files: string[],
  outDir: string
) {
  const spritesheetPath = path.join(outDir, "spritesheet.png");

  const rawSpriteData = await execAseprite(
    asepritePath,
    files,
    path.join(outDir, "spritesheet.png")
  );

  const sprites = transformSpriteData(rawSpriteData);

  return {
    spritesheetPath,
    sprites
  };
}

const nameRegex = /^(.*)\.(ase|aseprite)$/;
const nameAndNumberRegex = /^(.*) (\d+).(ase|aseprite)$/;
function transformSpriteData(spriteData: AsepriteData) {
  const sprites: { [name: string]: Rect[] } = {};

  for (const filename in spriteData.frames) {
    if (filename === "palette.aseprite") {
      continue;
    }

    const nameAndNumberResult = filename.match(nameAndNumberRegex);
    const nameResult = filename.match(nameRegex);

    if (nameAndNumberResult) {
      const [_, name, frameStr] = nameAndNumberResult;
      const frame = Number.parseInt(frameStr);

      if (typeof sprites[name] === "undefined") {
        sprites[name] = [];
      }

      sprites[name].splice(frame, 0, spriteData.frames[filename].frame);
    } else if (nameResult) {
      const name = nameResult[1];
      sprites[name] = [spriteData.frames[filename].frame];
    } else {
      sprites[filename] = [spriteData.frames[filename].frame];
    }
  }

  return sprites;
}

interface AudioData {
  sounds: { [name: string]: [number, number] };
  audiospritePath: string;
}

export default function handleSoundFiles(files: string[], outputDir: string) {
  return new Promise<AudioData>((resolve, reject) => {
    const cwd = process.cwd();

    tmp.dir((err, tmpdir) => {
      if (err) return reject(err);

      // audiosprite always outputs to cwd, which can be a big problem for file-watching
      // TODO: how to make this async-friendly?
      process.chdir(tmpdir);

      audiosprite(files, { output: "audiosprite" }, (err, data) => {
        if (err) return reject(err);

        let audiospritePath = "";

        for (const filename of data.resources) {
          // TODO: allow for multiple audio formats
          if (filename.endsWith(".mp3")) {
            audiospritePath = path.join(cwd, outputDir, filename);
            fs.renameSync(filename, audiospritePath);
          } else {
            fs.unlinkSync(filename);
          }
        }

        // transform { start, end, loop } into [start, end]
        const sounds: { [key: string]: [number, number] } = {};
        for (const spriteName in data.spritemap) {
          const { start, end } = data.spritemap[spriteName];
          sounds[spriteName] = [start, end];
        }

        process.chdir(cwd);
        resolve({ sounds, audiospritePath });
      });
    });
  });
}
