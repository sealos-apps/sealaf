import { Injectable, Logger } from '@nestjs/common'
import { RegionService } from '../region/region.service'
import { SystemDatabase } from 'src/system-database'
import { S3, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import * as assert from 'assert'
import { ClusterService } from 'src/region/cluster/cluster.service'

@Injectable()
export class CloudBinBucketService {
  private readonly logger = new Logger(CloudBinBucketService.name)
  private readonly db = SystemDatabase.db

  constructor(
    private readonly regionService: RegionService,
    private readonly clusterService: ClusterService,
  ) {}

  // get cloud-bin bucket or create it if not exists
  async ensureCloudBinBucket(appid: string) {
    const user = await this.clusterService.getUserByAppid(appid)
    const shortName = `cloud-bin`
    const bucketName = `sealaf-${appid}-${shortName}`
    try {
      const bucket = await this.clusterService.getStorageBucket(
        user,
        bucketName,
      )
      assert(
        bucket,
        `bucket ${bucketName} in ${user.namespace} is not ready, wait`,
      )
      return bucket
    } catch {}

    // create cloud-bin bucket in db
    const created = await this.clusterService.createStorageBucket(
      user,
      bucketName,
      'private',
    )
    this.logger.log(`creating cloud-bin bucket ${bucketName} for app ${appid}`)

    return created
  }

  async deleteCloudBinBucket(appid: string) {
    const user = await this.clusterService.getUserByAppid(appid)
    const shortName = `cloud-bin`
    const bucketName = `sealaf-${appid}-${shortName}`

    const res = await this.clusterService
      .deleteStorageBucket(user, bucketName)
      .catch((error) => {
        if (error?.response?.body?.reason === 'NotFound') return null
        throw error
      })
    this.logger.warn(`delete cloud-bin bucket ${bucketName} for app ${appid}`)
    return res
  }

  async createPullUrl(appid: string, filename: string) {
    const bucket = await this.ensureCloudBinBucket(appid)
    const command = new GetObjectCommand({
      Bucket: bucket.name,
      Key: filename,
    })

    const client = await this.getS3Client(appid)
    const url = await getSignedUrl(client, command, {
      expiresIn: 3600 * 24 * 7,
    })

    return url
  }

  async createPushUrl(appid: string, filename: string) {
    const bucket = await this.ensureCloudBinBucket(appid)
    const client = await this.getS3Client(appid)
    const command = new PutObjectCommand({
      Bucket: bucket.name,
      Key: filename,
    })
    const url = await getSignedUrl(client, command, {
      expiresIn: 3600 * 24 * 7,
    })

    return url
  }

  async getS3Client(appid: string) {
    const user = await this.clusterService.getUserByAppid(appid)
    const region = await this.regionService.findByAppId(appid)

    const conf = await this.clusterService.getStorageConf(user)

    const client = new S3({
      region: region.name,
      endpoint: conf.internal,
      credentials: {
        accessKeyId: conf.accessKey,
        secretAccessKey: conf.secretKey,
      },
      forcePathStyle: true,
    })

    return client
  }

  async getNodeModulesCachePullUrl(appid: string) {
    return await this.createPullUrl(appid, 'node_modules.tar')
  }

  async getNodeModulesCachePushUrl(appid: string) {
    return await this.createPushUrl(appid, 'node_modules.tar')
  }
}
