import { mkdirSync } from "node:fs";
import path from "node:path";
import multer from "multer";


const UPLOAD_DIR = path.resolve("./tmp/uploads");
mkdirSync(UPLOAD_DIR, { recursive: true });

/** A file the upload endpoint will not accept, answered as 400 rather than 500. */
export class UnsupportedMediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedMediaError";
  }
}

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

 
    fieldSize: 12 * 1024 * 1024, 
  },

  fileFilter: (req, file, cb) => {

    if (file.mimetype.startsWith("video/")) {
      cb(null, true);
    } else {
      cb(new UnsupportedMediaError("Only video files can be uploaded."));
    }
  },
});

export default upload;