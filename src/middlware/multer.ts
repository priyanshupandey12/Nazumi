import { mkdirSync } from "node:fs";
import path from "node:path";
import multer from "multer";


const UPLOAD_DIR = path.resolve("./tmp/uploads");
mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_DIR);
  },

  filename: (req, file, cb) => {
 
    const safeName = path.basename(file.originalname).replace(/[^\w.-]/g, "_");
    cb(null, `${Date.now()}-${safeName}`);
  },
});

const upload = multer({
  storage,

  limits: {
    fileSize: 500 * 1024 * 1024, // 500 MB
  },

  fileFilter: (req, file, cb) => {
    const allowed =
      file.mimetype.startsWith("image/") ||
      file.mimetype.startsWith("video/");

    if (allowed) {
      cb(null, true);
    } else {
      cb(new Error("Only images and videos are allowed."));
    }
  },
});

export default upload;