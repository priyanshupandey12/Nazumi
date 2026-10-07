import cloudinary from 'cloudinary';


cloudinary.v2.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME as string,
    api_key: process.env.CLOUDINARY_API_KEY as string,
    api_secret: process.env.CLOUDINARY_API_SECRET as string,
})


const uploadToCloudinary = async (filePath:string, folder:string)=>{
    try {
        if(!filePath || !folder) {
            throw new Error("Invalid file path or folder");
        }
        const result = await cloudinary.v2.uploader.upload(filePath, {
            folder: folder,
            resource_type: "auto",
        });
        return result;
    } catch (error) {
        throw new Error(`Error uploading to Cloudinary: ${describe(error)}`, { cause: error });
    }
}


const uploadRawToCloudinary = async (filePath: string, publicId: string) => {
    try {
        if (!filePath || !publicId) {
            throw new Error("Invalid file path or public ID");
        }
        return await cloudinary.v2.uploader.upload(filePath, {
            resource_type: "raw",
            public_id: publicId,
            use_filename: false,
            unique_filename: false,
            overwrite: true,
        });
    } catch (error) {
        throw new Error(
            `Error uploading raw asset "${publicId}" to Cloudinary: ${describe(error)}`,
            { cause: error },
        );
    }
}


/** An image at a known public ID, so it can be found again to delete. */
const uploadImageToCloudinary = async (filePath: string, publicId: string) => {
    try {
        if (!filePath || !publicId) {
            throw new Error("Invalid file path or public ID");
        }
        return await cloudinary.v2.uploader.upload(filePath, {
            resource_type: "image",
            public_id: publicId,
            use_filename: false,
            unique_filename: false,
            overwrite: true,
        });
    } catch (error) {
        throw new Error(
            `Error uploading image "${publicId}" to Cloudinary: ${describe(error)}`,
            { cause: error },
        );
    }
}

const deleteImageFolderFromCloudinary = async (prefix: string) => {
    try {
        if (!prefix) {
            throw new Error("Invalid prefix");
        }
        return await cloudinary.v2.api.delete_resources_by_prefix(prefix, {
            resource_type: "image",
            invalidate: true,
        });
    } catch (error) {
        throw new Error(
            `Error deleting image folder "${prefix}" from Cloudinary: ${describe(error)}`,
            { cause: error },
        );
    }
}

const deleteRawFolderFromCloudinary = async (prefix: string) => {
    try {
        if (!prefix) {
            throw new Error("Invalid prefix");
        }
        return await cloudinary.v2.api.delete_resources_by_prefix(prefix, {
            resource_type: "raw",
        
            invalidate: true,
        });
    } catch (error) {
        throw new Error(
            `Error deleting raw folder "${prefix}" from Cloudinary: ${describe(error)}`,
            { cause: error },
        );
    }
}



const publicIdFromUrl = (url: string): string | null => {
    const match = /\/upload\/(?:v\d+\/)?(.+)$/.exec(url);
    const withExtension = match?.[1];
    if (!withExtension) return null;

 
    return withExtension.replace(/\.[^./]+$/, "") || null;
}


const describe = (error: unknown): string => {
    if (error instanceof Error) return error.message;
    if (error && typeof error === "object" && "message" in error) {
        return String((error as { message: unknown }).message);
    }
    return String(error);
}

const deleteFromCloudinary = async (publicId:string)=>{
    try {
        if(!publicId){
            throw new Error("Invalid public ID");
        }
        const result = await cloudinary.v2.uploader.destroy(publicId, {
            invalidate: true,
        });

        if(result.result !== "ok"){
            throw new Error("Failed to delete from Cloudinary");
        }

        return result;

    } catch (error) {
        throw new Error(`Error deleting from Cloudinary: ${describe(error)}`, { cause: error });
    }
}

export {
    uploadToCloudinary,
    uploadRawToCloudinary,
    deleteFromCloudinary,
    deleteRawFolderFromCloudinary,
    uploadImageToCloudinary,
    deleteImageFolderFromCloudinary,
    publicIdFromUrl,
};