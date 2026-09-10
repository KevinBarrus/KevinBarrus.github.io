const siteLanguage = new URLSearchParams(window.location.search).get("lang") === "en" ? "en" : "zh";

const messages = {
  zh: {
    homePageTitle: "疯狂巴鲁斯 — 开发 / 研究 / 内容创作",
    homeDescription: "疯狂巴鲁斯的个人网站，记录技术、研究、项目与思考",
    articlePageTitle: "文章 — 疯狂巴鲁斯",
    tagPageTitle: "标签 — 疯狂巴鲁斯",
    about: "关于",
    home: "首页",
    switchLanguage: "English",
    mainNavigation: "主导航",
    socialLinks: "社交链接",
    role: "开发者 <span>/</span> 研究者 <span>/</span> 内容创作者",
    personalProjects: "个人项目",
    projectSlot: "精选项目预留区域",
    profileImage: "个人头像",
    avatarAlt: "轻音少女合照",
    articles: "文章",
    searchArticles: "搜索文章",
    filterByTag: "按标签筛选文章",
    yearNavigation: "按年份浏览文章",
    tags: "标签",
    noMatches: "没有找到匹配的文章。",
    noArticles: "文章将在这里慢慢生长。",
    back: "← 返回",
    tableOfContents: "目录",
    articleToc: "文章目录",
    loadingArticle: "正在加载文章…",
    articleLoadFailed: "文章加载失败",
    unknownError: "未知错误",
    serveOverHttp: "请通过本地 HTTP 服务访问：python3 -m http.server 8000",
    articleDeployError: "请确认文章索引和 Markdown 文件已部署（{error}）。",
    missingSlug: "缺少文章 slug",
    articleNotFound: "找不到文章：{slug}",
    markdownUnavailable: "Markdown 解析器加载失败",
    httpError: "{path} 返回 HTTP {status}",
    copy: "复制",
    copied: "已复制",
    copyFailed: "复制失败",
    updatedAt: "最新更新时间：{date}",
    switchTags: "切换文章标签",
    noTagSelected: "未选择标签",
    noTagArticles: "“{tag}” 下暂时还没有文章。",
  },
  en: {
    homePageTitle: "疯狂巴鲁斯 — Developer / Researcher / Content Creator",
    homeDescription: "The personal website of 疯狂巴鲁斯, featuring technology, research, projects, and reflections.",
    articlePageTitle: "Article — 疯狂巴鲁斯",
    tagPageTitle: "Tags — 疯狂巴鲁斯",
    about: "About",
    home: "Home",
    switchLanguage: "Chinese",
    mainNavigation: "Main navigation",
    socialLinks: "Social links",
    role: "Developer <span>/</span> Researcher <span>/</span> Content Creator",
    personalProjects: "Personal Projects",
    projectSlot: "Featured projects placeholder",
    profileImage: "Profile image",
    avatarAlt: "K-On group portrait",
    articles: "Articles",
    searchArticles: "Search articles",
    filterByTag: "Filter articles by tag",
    yearNavigation: "Browse articles by year",
    tags: "Tags",
    noMatches: "No matching articles found.",
    noArticles: "English articles are coming soon.",
    back: "← Back",
    tableOfContents: "Contents",
    articleToc: "Article contents",
    loadingArticle: "Loading article…",
    articleLoadFailed: "Unable to load article",
    unknownError: "Unknown error",
    serveOverHttp: "Please open the site through a local HTTP server: python3 -m http.server 8000",
    articleDeployError: "Please confirm that the article index and Markdown file are deployed ({error}).",
    missingSlug: "Missing article slug",
    articleNotFound: "Article not found: {slug}",
    markdownUnavailable: "The Markdown parser failed to load",
    httpError: "{path} returned HTTP {status}",
    copy: "Copy",
    copied: "Copied",
    copyFailed: "Copy failed",
    updatedAt: "Last updated: {date}",
    switchTags: "Switch article tag",
    noTagSelected: "No tag selected",
    noTagArticles: "No translated articles under “{tag}” yet.",
  },
};

function t(key, values = {}) {
  return Object.entries(values).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, value),
    messages[siteLanguage][key] || key,
  );
}

function localizedUrl(path, params = {}) {
  const url = new URL(path, window.location.href);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  if (siteLanguage === "en") url.searchParams.set("lang", "en");
  return url.href;
}

function initializeLanguage() {
  document.documentElement.lang = siteLanguage === "en" ? "en" : "zh-CN";
  document.querySelectorAll("[data-i18n]").forEach((element) => {
    element.textContent = t(element.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-html]").forEach((element) => {
    element.innerHTML = t(element.dataset.i18nHtml);
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((element) => {
    element.placeholder = t(element.dataset.i18nPlaceholder);
  });
  document.querySelectorAll("[data-i18n-aria-label]").forEach((element) => {
    element.setAttribute("aria-label", t(element.dataset.i18nAriaLabel));
  });
  document.querySelectorAll("[data-i18n-alt]").forEach((element) => {
    element.alt = t(element.dataset.i18nAlt);
  });
  document.querySelectorAll("[data-localized-link]").forEach((element) => {
    element.href = localizedUrl(element.getAttribute("href"));
  });

  const page = document.body.dataset.page;
  document.title = t(`${page}PageTitle`);
  const description = document.querySelector('meta[name="description"]');
  if (description) description.content = t("homeDescription");

  const languageLink = document.querySelector(".language-link");
  const target = new URL(window.location.href);
  if (siteLanguage === "en") target.searchParams.delete("lang");
  else target.searchParams.set("lang", "en");
  languageLink.textContent = t("switchLanguage");
  languageLink.href = target.href;
}

initializeLanguage();
