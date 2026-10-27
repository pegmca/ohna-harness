/** 页面 PNG 资产：按文档和页码作用域持久化。 */
export interface PageImageAsset {
  /** 文档逻辑 ID。 */
  documentId: string;
  /** 1-based 页码。 */
  pageNumber: number;
  /** PNG 原始字节。 */
  png: Uint8Array;
  /** 原始文件路径或逻辑来源。 */
  source: string;
}

/** 文档级页面图片仓储。 */
export interface PageImageRepository {
  /**
   * 保存一页 PNG，同一 documentId/pageNumber 覆盖。
   *
   * @param asset 页面图片资产。
   * @returns 完成后的 Promise。
   */
  put(asset: PageImageAsset): Promise<void>;

  /**
   * 读取一页 PNG。
   *
   * @param documentId 文档逻辑 ID。
   * @param pageNumber 1-based 页码。
   * @returns 命中资产或 null。
   */
  get(documentId: string, pageNumber: number): Promise<PageImageAsset | null>;

  /**
   * 创建 citation 使用的稳定页面引用。
   *
   * @param documentId 文档逻辑 ID。
   * @param pageNumber 1-based 页码。
   * @returns `<documentId>#page=N`。
   */
  createPageImageRef(documentId: string, pageNumber: number): string;
}

/**
 * 创建内存页面图片仓储。
 *
 * @returns 文档级内存图片仓储。
 */
export function createInMemoryPageImageRepository(): PageImageRepository {
  return new InMemoryPageImageRepository();
}

/** 文档级内存图片仓储实现。 */
class InMemoryPageImageRepository implements PageImageRepository {
  private readonly assets = new Map<string, PageImageAsset>();

  /**
   * 保存页面 PNG。
   *
   * @param asset 页面图片资产。
   * @returns 完成后的 Promise。
   */
  public async put(asset: PageImageAsset): Promise<void> {
    this.assets.set(this.createPageImageRef(asset.documentId, asset.pageNumber), {
      ...asset,
      png: new Uint8Array(asset.png)
    });
  }

  /**
   * 读取页面 PNG。
   *
   * @param documentId 文档逻辑 ID。
   * @param pageNumber 1-based 页码。
   * @returns 命中资产或 null。
   */
  public async get(documentId: string, pageNumber: number): Promise<PageImageAsset | null> {
    const asset = this.assets.get(this.createPageImageRef(documentId, pageNumber));
    return asset ? { ...asset, png: new Uint8Array(asset.png) } : null;
  }

  /**
   * 创建页面引用。
   *
   * @param documentId 文档逻辑 ID。
   * @param pageNumber 1-based 页码。
   * @returns `<documentId>#page=N`。
   */
  public createPageImageRef(documentId: string, pageNumber: number): string {
    return `${documentId}#page=${pageNumber}`;
  }
}
