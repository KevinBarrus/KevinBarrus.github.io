const tagTranslations = {
  "Agent开发": "Agent Development",
  "投资": "Investing",
  "个人成长": "Personal Growth",
  "强化学习": "Reinforcement Learning",
  "算法": "Algorithms",
  "后端": "Backend",
  "LLM": "LLM",
  "项目讲解": "Project Walkthroughs",
  "健康": "Health",
  "总结与思考": "Reflections & Reviews",
  "面试": "Interviews",
  "动漫": "Anime",
  "机器学习": "Machine Learning",
  "深度学习": "Deep Learning",
  "多模态": "Multimodal",
  "数学": "Mathematics",
  "英语": "English",
  "AI Infra": "AI Infra",
  "开源贡献": "Open Source Contributions",
  "Linux": "Linux",
  "MySQL": "MySQL",
  "Redis": "Redis",
  "计算机网络": "Computer Networks",
  "操作系统": "Operating Systems",
  "git": "Git",
  "AI工具": "AI Tools",
  "后训练": "Post-training",
  "游戏": "Games",
  "钢琴演奏": "Piano Performances",
  "斯诺克比赛解说": "Snooker Commentary",
  "斯诺克游戏集锦": "Snooker Game Highlights",
};

const siteTags = Object.keys(tagTranslations);

function tagLabel(tag) {
  return siteLanguage === "en" ? tagTranslations[tag] || tag : tag;
}
