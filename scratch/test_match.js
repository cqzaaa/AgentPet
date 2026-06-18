const text = `我已经为您生成了一个新的随机柱状图，包含5个类别的随机数据：
[随机柱状图](local-file:///d:/Electron/AgentPet/scratch/bar_chart_1718712000.png)
图表展示了以下随机数据分布：
  类别A: 34
  类别B: 78
  类别C: 56
  类别D: 92
  类别E: 21
图表使用了默认主题...`;

function testRender(text) {
  const parts = [];
  const linkOrImgRegex = /(!)?\[(.*?)\]\((.*?)\)/g;
  let match;
  let lastIndex = 0;

  const isImageSrc = (url) => {
    if (!url) return false;
    // 1. 本地图片协议
    if (url.startsWith('local-file:///')) {
      const cleanUrl = url.split('?')[0].split('#')[0].toLowerCase();
      return cleanUrl.endsWith('.png') || 
             cleanUrl.endsWith('.jpg') || 
             cleanUrl.endsWith('.jpeg') || 
             cleanUrl.endsWith('.gif') || 
             cleanUrl.endsWith('.webp') || 
             cleanUrl.endsWith('.bmp') ||
             cleanUrl.endsWith('.svg');
    }
    // 2. 远程常见图片后缀
    const cleanUrl = url.split('?')[0].split('#')[0].toLowerCase();
    if (cleanUrl.endsWith('.png') || 
        cleanUrl.endsWith('.jpg') || 
        cleanUrl.endsWith('.jpeg') || 
        cleanUrl.endsWith('.gif') || 
        cleanUrl.endsWith('.webp') || 
        cleanUrl.endsWith('.bmp') ||
        cleanUrl.endsWith('.svg')) {
      return true;
    }
    // 3. base64图片数据
    if (url.startsWith('data:image/')) {
      return true;
    }
    return false;
  };

  while ((match = linkOrImgRegex.exec(text)) !== null) {
    const textBefore = text.substring(lastIndex, match.index);
    if (textBefore.trim()) {
      parts.push({ type: 'text', content: textBefore });
    }

    const isExplicitImg = !!match[1];
    const alt = match[2];
    const src = match[3];

    console.log('Match found:', { isExplicitImg, alt, src });
    const isImg = isExplicitImg || isImageSrc(src);
    console.log('Is image source:', isImg);

    if (isImg) {
      parts.push({ type: 'image', src, alt });
    } else {
      parts.push({ type: 'link', src, alt });
    }

    lastIndex = linkOrImgRegex.lastIndex;
  }

  const textAfter = text.substring(lastIndex);
  if (textAfter.trim()) {
    parts.push({ type: 'text', content: textAfter });
  }

  return parts;
}

console.log(JSON.stringify(testRender(text), null, 2));
