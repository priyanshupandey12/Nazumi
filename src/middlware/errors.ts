import type { NextFunction, Request, Response } from "express";
import { MulterError } from "multer";
import { UnsupportedMediaError } from "./multer.js";

/**
 * Turns upload failures into JSON.
 *
 * Without this, anything multer rejects falls through to Express's default
 * handler, which answers with an HTML page containing a stack trace: the client
 * cannot parse it, so every one of these read as a bare "Internal Server
 * Error", and the response leaked absolute server paths.
 */
const MULTER_STATUS: Record<string, { status: number; message: string }> = {
  LIMIT_FILE_SIZE: {
    status: 413,
    message: "That video is larger than the 500 MB limit.",
  },
  LIMIT_FIELD_VALUE: {
    status: 413,
    message:
      "That thumbnail is too large. Pick an image under about 9 MB, or upload without one.",
  },
  LIMIT_UNEXPECTED_FILE: {
    status: 400,
    message: "Unexpected file field. The video must be sent as \"video\".",
  },
  LIMIT_FILE_COUNT: { status: 400, message: "Only one video can be uploaded at a time." },
  LIMIT_PART_COUNT: { status: 400, message: "That upload had too many parts." },
  LIMIT_FIELD_COUNT: { status: 400, message: "That upload had too many fields." },
  LIMIT_FIELD_KEY: { status: 400, message: "A field name in that upload was too long." },
};

export const uploadErrorHandler = (
  error: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
) => {
 
  if (res.headersSent) return next(error);

  if (error instanceof MulterError) {
    const mapped = MULTER_STATUS[error.code] ?? {
      status: 400,
      message: "That upload could not be accepted.",
    };
    console.warn(`[upload] rejected (${error.code}): ${error.message}`);
    return res.status(mapped.status).json({ message: mapped.message });
  }

  if (error instanceof UnsupportedMediaError) {
    return res.status(400).json({ message: error.message });
  }

  // express.json() rejects an oversized body with its own error type; without
  // this it would fall through to a 500 for what is a client-side mistake.
  if (
    typeof error === "object" &&
    error !== null &&
    (error as { type?: string }).type === "entity.too.large"
  ) {
    return res.status(413).json({
      message: "That request is too large. Try a smaller image.",
    });
  }


  console.error("[api] unhandled error:", error);
  return res.status(500).json({ message: "Something went wrong on our end." });
};
