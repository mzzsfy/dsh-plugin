// dsh-llm 图片卸载管线双形态特性检测。宿主 0.1.7 起移除
// offloadRequestImagesWithPolicy,换形为 requiredImageOffload /
// projectOffloadedImages / IMAGE_OFFLOAD_REQUIRED(路由只上报必需卸载量,
// 标记与重试由上游承担);0.1.2–0.1.5 为路由内两段瞬时投影。宿主 loader
// 对 peerDependencies 声明的 @deepseek-ai/* 强制路由到宿主安装树,静态
// import 旧名在 0.1.7 宿主即加载崩溃——两个形态都只允许运行时探测。
//
// 图片读出契约同步换形:0.1.7 attachments 服务要求精确目标尺寸
// {width, height, maxBytes}(requestImageTarget 同构,尺寸经 dsh-attachment
// 的 requestImageDimensions 预算化),0.1.5 要求 {maxPixels, maxBytes};
// 由适配器 kind 决定 readImageRequest 第二参形态。

/**
 * 从宿主模块面选取图片卸载管线适配器。
 * @param {object} dshLlm 运行宿主的 @deepseek-ai/dsh-llm 模块面
 * @param {object|undefined} [dshAttachment] 运行宿主的 @deepseek-ai/dsh-attachment 模块面,
 *   仅 routed 形态需要(requestImageDimensions)
 * @returns {{kind:'routed', required:function, project:function, requiredError:function,
 *            requestTarget:function}|{kind:'transient', project:function}|null}
 *   null = 宿主两形态皆缺,调用方按宿主能力缺失干净禁用
 */
export function imageOffloadAdapter(dshLlm, dshAttachment) {
  if (typeof dshLlm?.requiredImageOffload === 'function'
    && typeof dshLlm?.projectOffloadedImages === 'function'
    && typeof dshLlm?.offloadedImageText === 'function'
    && typeof dshLlm?.LlmError === 'function'
    && typeof dshLlm?.IMAGE_OFFLOAD_REQUIRED_CODE === 'string'
    && typeof dshAttachment?.requestImageDimensions === 'function') {
    return {
      kind: 'routed',
      // 官方 requiredImageOffload 直传:统计超出预算的最旧保留块数
      required: (messages, maxBytes, versionBytes) => dshLlm.requiredImageOffload(
        messages,
        { representation: 'base64', ...(maxBytes === undefined ? {} : { maxBytes }) },
        versionBytes,
      ),
      project: (messages, placeholder) => dshLlm.projectOffloadedImages(messages, placeholder),
      // 官方同构错误面:上游据 code 与 offloadImages 标记最旧 N 张并重试
      requiredError: (maxBytes, count) => new dshLlm.LlmError(
        `pi-ai request images exceed the ${maxBytes}-byte base64 bound; ${count} more oldest occurrence(s) must be offloaded.`,
        dshLlm.IMAGE_OFFLOAD_REQUIRED_CODE,
        { offloadImages: count },
      ),
      // 官方 requestImageTarget 同构:预算像素内的确定性请求尺寸 + 字节上限
      requestTarget: (ref, budget) => ({
        ...dshAttachment.requestImageDimensions(ref.width, ref.height, budget.maxPixels),
        maxBytes: budget.maxBytes,
      }),
    }
  }
  if (typeof dshLlm?.offloadRequestImagesWithPolicy === 'function') {
    return {
      kind: 'transient',
      project: (messages, policy) => dshLlm.offloadRequestImagesWithPolicy(messages, policy),
    }
  }
  return null
}
