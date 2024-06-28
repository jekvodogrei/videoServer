const express = require("express");
const fs = require("fs-extra");
const { spawn } = require("child_process");
const path = require("path");
const mongoose = require("mongoose");
const moment = require("moment-timezone");
const app = express();
const PORT = 3007;

const cameraSchema = new mongoose.Schema({
   name: String,
   url: String,
   ip: String,
});

app.use(express.json());

app.use((req, res, next) => {
   res.setHeader("Access-Control-Allow-Origin", "*");
   res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE");
   res.setHeader("Access-Control-Allow-Headers", "Content-Type");
   next();
});

const Camera = mongoose.model("Camera", cameraSchema);

mongoose
   .connect("mongodb://91.196.177.159:27017/triolan", {
      useNewUrlParser: true,
      useUnifiedTopology: true,
   })
   .then(() => {
      console.log("Успішне підключення до бази даних");
      startCameraStreams();
      setInterval(() => {
         console.log("Checking for new cameras...");
         checkForNewCameras();
      }, 60 * 1000); // Перевірка нових камер кожні 5 хвилин
      setInterval(monitorCameraActivity, 60 * 1000); // Перевірка активності камер кожну хвилину
      setInterval(checkAndCreateNewDateFolder, 60 * 1000); // Перевірка на створення нової папки кожну хвилину
   })
   .catch((err) => {
      console.error("Помилка підключення до бази даних:", err);
   });

const activeStreams = new Map();
let lastCheckedDate = moment().tz("Europe/Kiev").format("YYYY-MM-DD");

function searchFiles(cameraIp, startDate, endDate) {
   const videoPath = path.join(__dirname, `public/videos`);
   const cameraFolderPath = path.join(videoPath, cameraIp);

   if (!fs.existsSync(cameraFolderPath)) {
      return [];
   }

   const files = fs.readdirSync(cameraFolderPath);
   const foundFiles = [];

   files.forEach((file) => {
      const filePath = path.join(cameraFolderPath, file);
      const fileStat = fs.statSync(filePath);
      const fileModifiedTime = new Date(fileStat.mtime);

      if (fileModifiedTime >= startDate && fileModifiedTime <= endDate) {
         foundFiles.push(filePath);
      }
   });
   return foundFiles;
}

function startCameraStreams() {
   Camera.find({})
      .exec()
      .then((cameras) => {
         cameras.forEach((camera) => {
            startFfmpegForCamera(camera);
         });
      })
      .catch((err) => {
         console.log("Помилка при отриманні списку камер:", err);
      });
}

function checkForNewCameras() {
   Camera.find({})
      .exec()
      .then((cameras) => {
         const cameraIps = new Set(cameras.map((camera) => camera.ip));
         cameras.forEach((camera) => {
            const isActive = activeStreams.has(camera.ip);
            if (!isActive) {
               isCameraAvailable(camera.url).then((isAvailable) => {
                  if (isAvailable) {
                     console.log(
                        `Starting new camera stream for ${camera.name} (${camera.ip})`
                     );
                     startFfmpegForCamera(camera);
                  } else {
                     console.log(
                        `Camera ${camera.name} (${camera.ip}) is not available`
                     );
                  }
               });
            } else {
               console.log(
                  `Camera ${camera.name} (${camera.ip}) is already streaming`
               );
            }
         });
         activeStreams.forEach((_, ip) => {
            if (!cameraIps.has(ip)) {
               console.log(`Stopping stream for removed camera ${ip}`);
               stopCameraStream(ip);
            }
         });
      })
      .catch((err) => {
         console.log("Помилка при перевірці нових камер:", err);
      });
}

function stopCameraStream(cameraIp) {
   const stream = activeStreams.get(cameraIp);
   if (stream && stream.process) {
      stream.process.kill("SIGTERM");
      activeStreams.delete(cameraIp);
      console.log(`Stream for camera ${cameraIp} stopped.`);
   }
}

function monitorCameraActivity() {
   activeStreams.forEach((stream, ip) => {
      const { process, lastSegmentTimestamp } = stream;
      const currentTime = Date.now();
      if (currentTime - lastSegmentTimestamp > 30000) {
         console.log(`No new segments detected for ${ip}, restarting stream.`);
         process.kill("SIGTERM");
         activeStreams.delete(ip);
         retryStartCameraStream(ip);
      }
   });
}

function retryStartCameraStream(cameraIp) {
   Camera.findOne({ ip: cameraIp }).then((camera) => {
      if (camera) {
         let retries = 0;
         const retryInterval = setInterval(async () => {
            const isAvailable = await isCameraAvailable(camera.url);
            if (isAvailable) {
               clearInterval(retryInterval);
               startFfmpegForCamera(camera);
            } else if (retries >= 5) {
               clearInterval(retryInterval);
               console.log(
                  `Camera ${cameraIp} is not available after multiple retries.`
               );
            }
            retries++;
         }, 60000); // Retry every minute
      }
   });
}

function isCameraAvailable(cameraUrl) {
   return new Promise((resolve) => {
      const ffprobe = spawn("ffprobe", [
         "-v",
         "error",
         "-show_entries",
         "stream=codec_name",
         "-of",
         "default=nw=1:nk=1",
         cameraUrl,
      ]);

      ffprobe.on("close", (code) => {
         resolve(code === 0);
      });
   });
}

function checkAndCreateNewDateFolder() {
   const currentDate = moment().tz("Europe/Kiev").format("YYYY-MM-DD");
   console.log(
      `Current date: ${currentDate}, last checked date: ${lastCheckedDate}`
   );

   if (currentDate !== lastCheckedDate) {
      lastCheckedDate = currentDate;
      Camera.find({})
         .exec()
         .then((cameras) => {
            cameras.forEach((camera) => {
               const outputDir = getOutputDir(camera.ip, currentDate);
               if (!fs.existsSync(outputDir)) {
                  fs.mkdirSync(outputDir, { recursive: true });
                  console.log(
                     `Created new directory for ${camera.ip}: ${outputDir}`
                  );
               }
               stopCameraStream(camera.ip);
               startFfmpegForCamera(camera);
            });
         })
         .catch((err) => {
            console.log("Помилка при створенні нових папок:", err);
         });
   }
}

function getOutputDir(cameraIp, date) {
   return path.join(__dirname, `public/videos/${date}/${cameraIp}`);
}

async function startFfmpegForCamera(camera) {
   console.log(`Starting ffmpeg for ${camera.name} (${camera.ip})`);

   const currentDate = moment().tz("Europe/Kiev").format("YYYY-MM-DD");
   const outputDir = getOutputDir(camera.ip, currentDate);

   console.log(`Output directory for ${camera.name}: ${outputDir}`);
   if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
   }

   const m3u8File = path.join(outputDir, "stream.m3u8");
   const segmentFileTemplate = path.join(outputDir, "stream%d.ts");

   let lastSegmentTimestamp = Date.now();

   const ffmpegProcess = spawn("ffmpeg", [
      "-rtsp_transport",
      "tcp",
      "-i",
      camera.url,
      "-c:v",
      "copy",
      "-f",
      "hls",
      "-hls_time",
      "5",
      "-hls_list_size",
      "0",
      "-hls_flags",
      "append_list",
      "-hls_segment_filename",
      segmentFileTemplate,
      m3u8File,
   ]);

   ffmpegProcess.stderr.on("data", (data) => {
      console.error(`ffmpeg stderr for ${camera.name}: ${data}`);
      if (data.toString().includes("bitrate=N/A")) {
         const currentTime = Date.now();
         if (currentTime - lastSegmentTimestamp > 30000) {
            console.log(
               `No new segments detected for ${camera.name}, restarting stream.`
            );
            ffmpegProcess.kill("SIGTERM");
         }
      } else {
         lastSegmentTimestamp = Date.now();
      }
   });

   ffmpegProcess.on("exit", async (code) => {
      console.log(`ffmpeg process for ${camera.name} exited with code ${code}`);
      activeStreams.delete(camera.ip);
      const isAvailable = await isCameraAvailable(camera.url);
      if (isAvailable) {
         startFfmpegForCamera(camera);
      } else {
         retryStartCameraStream(camera.ip);
      }
   });

   activeStreams.set(camera.ip, {
      process: ffmpegProcess,
      lastSegmentTimestamp,
   });

   console.log(`ffmpeg process started for ${camera.name}`);
}

app.get("/info", (req, res) => {
   const serverInfo = {
      ip: "localhost",
      port: PORT,
   };
   res.json(serverInfo);
});

app.get("/cameras", async (req, res) => {
   try {
      const cameras = await Camera.find({});
      res.json(cameras);
   } catch (error) {
      res.status(500).send("Error fetch cameras");
   }
});

app.get("/stream/:cameraIp", (req, res) => {
   const { cameraIp } = req.params;
   console.log(`Received request for stream from camera IP: ${cameraIp}`);

   // Логіка для отримання URL стріму камери
   const streamUrl = `http://localhost:${PORT}/stream/${cameraIp}`;

   if (!fs.existsSync(streamUrl)) {
      console.error(`Stream URL not found: ${streamUrl}`);
      return res.status(404).send("Stream URL not found");
   }

   res.json({ url: streamUrl });
});

app.get("/video/:cameraIp/:segment", (req, res) => {
   const { cameraIp, segment } = req.params;
   console.log(
      `Received request for segment: ${segment} from camera IP: ${cameraIp}`
   );
   const currentDate = moment().tz("Europe/Kiev").format("YYYY-MM-DD");
   const videoPath = getOutputDir(cameraIp, currentDate);
   const tsFilePath = path.join(videoPath, segment);

   if (fs.existsSync(tsFilePath)) {
      console.log(`Sending file: ${tsFilePath}`);
      res.sendFile(tsFilePath);
   } else {
      console.error(`Segment not found: ${tsFilePath}`);
      res.status(404).send("Segment not found");
   }
});

app.get("/video/:date/:cameraIp/:segment", (req, res) => {
   const { date, cameraIp, segment } = req.params;
   console.log(
      `Received request for segment: ${segment} from camera IP: ${cameraIp} on date: ${date}`
   );
   const videoPath = getOutputDir(cameraIp, date);
   const tsFilePath = path.join(videoPath, segment);

   if (fs.existsSync(tsFilePath)) {
      console.log(`Sending file: ${tsFilePath}`);
      res.sendFile(tsFilePath);
   } else {
      console.error(`Segment not found: ${tsFilePath}`);
      res.status(404).send("Segment not found");
   }
});

app.get("/archive/:date/:cameraIp/:startDate/:endDate", (req, res) => {
   const { date, cameraIp, startDate, endDate } = req.params;
   const start = new Date(startDate);
   const end = new Date(endDate);
   const foundFiles = searchFiles(cameraIp, start, end);

   res.json({
      url: `http://localhost:${PORT}/archive/${date}/${cameraIp}/${startDate}/${endDate}`,
   });

   if (foundFiles.length > 0) {
      const mergedVideo = mergeVideoFiles(cameraIp, foundFiles);
      res.json({ url: mergedVideo });
   } else {
      res.status(404).send("No files found");
   }
});

app.get("/info", (req, res) => {
   res.json({
      ip: "localhost", // тут ви можете динамічно визначити IP
      port: PORT,
   });
});

app.post("/add-camera", (req, res) => {
   const { name, url, ip } = req.body;
   const newCamera = new Camera({ name, url, ip });
   newCamera
      .save()
      .then(() => {
         console.log("New camera added successfully");
         res.status(200).send("Camera added");
      })
      .catch((err) => {
         console.error("Error adding new camera:", err);
         res.status(500).send("Error adding camera");
      });
});

app.listen(PORT, () => {
   console.log(`Сервер запущений на порту ${PORT}`);
});
