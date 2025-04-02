import { Injectable } from '@nestjs/common';
import {
    S3Client,
    PutObjectCommand,
    CreateBucketCommand,
    HeadBucketCommand,
    BucketLocationConstraint,
    PutObjectCommandInput,
} from '@aws-sdk/client-s3';

@Injectable()
export class S3Service {
    private s3Client: S3Client;

    constructor() {
        const region = process.env.API_AWS_REGION;
        const credentials = {
            accessKeyId: process.env.API_AWS_USERNAME,
            secretAccessKey: process.env.API_AWS_PASSWORD,
        };

        this.s3Client = new S3Client({
            region,
            credentials,
        });
    }

    public async createUniqueBucket(): Promise<string> {
        const bucketName = process.env.API_AWS_BUCKET_NAME_ASSISTANT;

        const bucketExists = await this.checkIfBucketExists(bucketName);

        if (!bucketExists) {
            await this.createBucket(bucketName);
        }

        return bucketName;
    }

    private async checkIfBucketExists(bucketName: string): Promise<boolean> {
        try {
            const headBucketCommand = new HeadBucketCommand({
                Bucket: bucketName,
            });
            await this.s3Client.send(headBucketCommand);
            console.log(`Bucket ${bucketName} already exists.`);
            return true;
        } catch (error) {
            if (error.name === 'NotFound') {
                console.log(`Bucket ${bucketName} does not exist.`);
                return false;
            }
            throw error;
        }
    }

    private async createBucket(bucketName: string): Promise<void> {
        try {
            const createBucketCommand = new CreateBucketCommand({
                Bucket: bucketName,
                CreateBucketConfiguration: {
                    LocationConstraint: BucketLocationConstraint.us_east_2,
                },
            });
            await this.s3Client.send(createBucketCommand);
            console.log(`Bucket ${bucketName} created successfully.`);
        } catch (error) {
            console.error(`Error creating bucket ${bucketName}:`, error);
            throw error;
        }
    }

    public async uploadFile(
        bucketName: string,
        fileContent: Buffer,
        fileName: string,
        contentType: string,
    ) {
        const params: PutObjectCommandInput = {
            Bucket: bucketName,
            Key: fileName,
            Body: fileContent,
            ContentType: contentType,
            // ACL: 'public-read',
        };

        try {
            const command = new PutObjectCommand(params);
            await this.s3Client.send(command);
            console.log(
                `File uploaded successfully to ${bucketName}/${fileName}`,
            );
        } catch (error) {
            console.error(
                `Error uploading file to ${bucketName}/${fileName}:`,
                error,
            );
            throw error;
        }
    }
}
