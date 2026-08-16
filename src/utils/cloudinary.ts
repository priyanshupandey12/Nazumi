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
        throw new Error("Error uploading to Cloudinary");
        return null;
    }
}

const deleteFromCloudinary = async (publicId:string)=>{
    try {
        if(!publicId){
            throw new Error("Invalid public ID");
        }
        const result = await cloudinary.v2.uploader.destroy(publicId);

        if(result.result !== "ok"){
            throw new Error("Failed to delete from Cloudinary");
        }

        return result;
        
    } catch (error) {
        throw new Error("Error deleting from Cloudinary");
        return null;
    }
}

export { uploadToCloudinary, deleteFromCloudinary };