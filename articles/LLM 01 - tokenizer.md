# Tokenizer：文本是怎么变成模型输入的

大语言模型不能直接处理文字。对于模型来说：

```text
I love AI
```

或者：

```text
我喜欢 AI
```

都不是可以直接计算的东西。神经网络最终只能处理数字。所以在文本真正进入模型之前，需要经过一个步骤：

```text
文本
↓
UTF-8 编码
↓
字节序列
↓
Tokenizer
↓
Token ID
↓
模型
```

Tokenizer 做的事情，就是把文本转换成一串整数。


## 1. Tokenizer 实际看到的是什么？

Tokenizer 并不是直接“看到”：

```text
我
喜欢
AI
```

然后思考应该怎么分词。

对于很多现代 LLM 使用的 byte-level tokenizer，文本会先按照 UTF-8 编码转换成字节。例如英文字符：

```text
A
```

UTF-8 中只占 1 个字节：

```text
41
```

而一个常见汉字通常占 3 个字节。所以：

```text
文本
↓
UTF-8
↓
一串 byte
```

Tokenizer 真正进行切分和合并的基础，是这些字节以及由它们组成的片段。因此更准确的流程是：

```text
Text
↓
Bytes
↓
Tokens
↓
Token IDs
```

## 2. 什么是 Token？

Token 可以理解为：Tokenizer 最终决定作为一个整体处理的一段字节序列。它在人类看来可能对应：

- 一个完整单词
- 一个单词的一部分
- 一个汉字
- 几个汉字
- 一个标点
- 一个空格
- 一段代码
- 甚至只是某个字符的一部分字节

例如：

```text
playing
```

可能被切成：

```text
play
ing
```

也可能整个就是一个 Token。

这并不是因为 Tokenizer 理解英语语法，而是因为这些字节组合在训练数据中出现得足够频繁。

## 3. 为什么不能每个字节都作为一个 Token？

理论上当然可以。因为只要覆盖所有 byte，就可以表示任意 UTF-8 文本。但这样会导致序列太长。例如一个英文单词：

```text
transformer
```

如果完全按字节处理，基本就要拆成：

```text
t r a n s f o r m e r
```

很多个 Token。而中文字符通常本身就需要多个 UTF-8 字节，如果完全不合并，会更加碎。Token 数越多，模型后续需要处理的序列就越长。所以我们希望把经常一起出现的字节组合起来。


## 4. 为什么也不能每个单词都作为一个 Token？

另一个极端是：

```text
I love artificial intelligence
```

直接切成：

```text
I
love
artificial
intelligence
```

这样看起来很简单。但问题是世界上的单词、名字、代码、网址和新造词几乎是无限的。例如：

```text
play
playing
played
player
```

如果全部单独保存，就需要占用很多 Token。遇到一个从没见过的新字符串时，也很难直接处理。所以现代 Tokenizer 通常使用一种折中的方式：**Subword Tokenization。**


## 5. Subword：常见的整体保留，不常见的拆开

核心思想很简单：常见的字节组合尽量合并成较大的 Token，少见的内容拆成更小的部分。

例如：

```text
playing
```

可能变成：

```text
play
ing
```

这样：

```text
playing
played
player
```

可以共享：

```text
play
```

而不是每个完整单词都单独占一个位置。


## 6. 怎么知道要这么拆？

一种经典的方法叫 **BPE**。它的核心过程可以理解成：从较小的单位开始，不断寻找最常一起出现的相邻片段，然后合并。例如训练数据里经常出现：

```text
hug
hug
hug
hugs
```

一开始可以看成较小的单位：

```text
h u g
h u g
h u g
h u g s
```

统计相邻组合：

```text
h + u
u + g
g + s
```

如果：

```text
h + u
```

非常常见，就把它们合并：

```text
h + u
↓
hu
```

之后又可能继续：

```text
hu + g
↓
hug
```

最后：

```text
hug
```

就成为一个 Token。

对于 byte-level BPE，底层思想一样，只不过实际参与合并的是字节和已经合并出来的字节片段。


## 7. Tokenizer 不懂语言学

这一点很重要。如果：

```text
playing
```

被切成：

```text
play + ing
```

不是因为 Tokenizer 知道：

```text
play 是词根
ing 是后缀
```

它只是在训练数据中发现这些字节组合经常重复出现。如果另一个切分方式统计上更合适，它完全可能切成：

```text
pla
ying
```

所以 Tokenizer 本质上做的是统计压缩，而不是语言理解。


## 8. Vocabulary：Token 和编号之间的表

Tokenizer 训练完成以后，会得到一个词表。例如：

```text
I        -> 100
love     -> 521
AI       -> 830
play     -> 1204
ing      -> 341
```

于是：

```text
I love AI
```

经过 Tokenizer 后，可能得到：

```text
[100, 521, 830]
```

这些数字就是 **Token ID**。

## 9. Token ID 只是编号

假设：

```text
AI -> 830
play -> 1204
```

并不意味着：

```text
1204 > 830
```

有什么语言上的含义。Token ID 只是索引。类似数据库中的：

```text
user_id = 830
```

它只负责告诉模型：当前是词表里的第 830 个 Token。所以：

```text
文本
↓
UTF-8 字节
↓
Token
↓
Token ID
```

到这里，Tokenizer 的工作基本结束了。


## 10. 模型真正处理的不是 Token ID

模型不会直接把：

```text
[100, 521, 830]
```

当作有语言意义的数值来计算。下一步，它会根据这些 ID 找到每个 Token 对应的一串数字。

例如：

```text
100
↓
[0.2, -0.7, 0.1, ...]

521
↓
[0.8, 0.3, -0.2, ...]
```

这些数字才真正进入 Transformer。因此完整流程是：

```text
文本
↓
UTF-8
↓
字节序列
↓
Tokenizer
↓
Token ID
↓
找到每个 Token 对应的一串数字
↓
Transformer
```

Tokenizer 负责的是前半段。

## 11. 如何根据 ID 找到对应数字

这一步本质上就是查表。假设 tokenizer 输出：

```text
[100, 521, 830]
```
模型内部会有一张很大的表，每一行对应一个 token ID。
比如为了方便，我们假设词表只有 5 个 token，每个 token 用 4 个数字表示：

```text
ID 0 -> [ 0.2, -0.1,  0.7,  0.3]
ID 1 -> [-0.4,  0.8,  0.1, -0.2]
ID 2 -> [ 0.6,  0.5, -0.3,  0.9]
ID 3 -> [ 0.1, -0.7,  0.4,  0.2]
ID 4 -> [ 0.9,  0.2,  0.3, -0.5]
```

如果输入 token ID 是：

```text
[1, 4, 2]
```

那就直接取：

```text
ID 1 -> [-0.4, 0.8, 0.1, -0.2]
ID 4 -> [ 0.9, 0.2, 0.3, -0.5]
ID 2 -> [ 0.6, 0.5,-0.3,  0.9]
```

于是模型得到：

```text
[
  [-0.4, 0.8, 0.1, -0.2],
  [ 0.9, 0.2, 0.3, -0.5],
  [ 0.6, 0.5,-0.3, 0.9]
]
```

这一步就叫 Embedding lookup。你可以先把它理解成：
token ID 是行号，模型拿这个行号去一张表里取对应的一行数字。

这张表不是 tokenizer 训练出来的，而是 LLM 自己的参数之一。模型刚开始训练时，这些数字基本是随机的。训练过程中，通过反向传播不断调整。比如一开始：

```text
dog -> [0.91, -0.32, 0.18, ...]
cat -> [-0.44, 0.72, 0.09, ...]
```

你会问：凭什么 dog 和 cat 就是这个向量？不能换成其它数值吗？

事实上一开始的这些值完全没什么意义。但模型训练很多文本以后，这些数字会不断被改。最终，像 dog、cat、animal这种在相似上下文里经常出现的 token，其数字表示往往会形成一些相似的结构。

所以关键是：

- Tokenizer 负责：文字 -> token ID
- 模型的 embedding 表负责：token ID -> 一串数字


总之，这些数字不是 tokenizer 决定的。Tokenizer 只决定：

```text
AI -> 830
```

至于：

```
830 -> [0.23, -0.91, 0.44, ...]
```

这一串数字是什么，是模型训练出来的。


## 12. 为什么中文通常更容易消耗更多 Token？

这里有两个原因。

第一个原因来自 UTF-8。英文 ASCII 字符通常只需要 1 个字节，而常见汉字通常需要 3 个字节。

所以在 byte-level tokenizer 的最初表示中，中文本身就会产生更多字节。但这并不意味着 1 个汉字 = 3 个 Token，因为 Tokenizer 后续还会继续合并。

第二个原因更加重要：Tokenizer 在训练时到底学到了哪些高频字节组合。

如果训练数据里英文很多，那么：

```text
the
ing
computer
tion
```

这些字符串很可能被合并成很大的 Token。一个原本有很多字节的英文单词，最终可能只占 1 个 Token。

如果中文训练数据相对不足，那么中文里的常见组合可能没有被充分合并。于是相同信息量的文本，中文可能需要更多 Token。

所以真正决定 Token 效率的是 UTF-8 字节长度 + Tokenizer 学到的合并规则

## 13. Token 多意味着什么？

LLM 的上下文长度通常按 Token 计算。例如：

```text
128k context
```

意味着最多大约处理：

```text
128000 tokens
```

不是 128000 个字。所以如果同样一段信息：

```text
语言 A -> 20 tokens
语言 B -> 30 tokens
```

语言 B 就会：

- 更快占满上下文窗口
- 产生更多输入 Token
- 推理成本更高
- 后续 Transformer 处理的序列更长

所以 Tokenizer 对一种语言是否友好，会直接影响模型使用效率。


## 14. Tokenizer 本质上在做什么？

可以把它理解成一个压缩问题。我们希望Token 种类不要无限多，同时又希望一段文本不要被切成太多 Token。所以 Tokenizer 会倾向于：

```text
常见字节组合
↓
合并成更大的 Token

少见字节组合
↓
保留为更小的 Token
```

最终用有限的词表，表示几乎任意文本。


## 15. 完整流程

整个过程可以压缩成：

```text
文本
↓
UTF-8 编码
↓
字节
↓
根据训练好的规则合并
↓
Token
↓
Token ID
↓
后续模型计算
```

反过来生成文本时：

```text
Token ID
↓
Token
↓
字节
↓
UTF-8 解码
↓
文本
```

所以 Tokenizer 位于人类文本和神经网络之间。它负责把任意文本转换成一串离散编号，再把生成出来的编号还原成人类可读的文本。

## 总结

Tokenizer 最核心的事情只有三步：

```text
文本
↓
UTF-8 字节

字节
↓
Token

Token
↓
Token ID
```

对于 byte-level tokenizer 来说，它并不是直接理解“中文”“英文”或者“单词”，它看到的基础是字节。

BPE 等算法再根据训练数据中的统计规律，把经常一起出现的字节组合成更大的 Token。最终：

```text
Text
↓
Bytes
↓
Tokens
↓
Token IDs
```

Tokenizer 的工作到这里结束。

下一步，才是把这些 Token ID 变成真正送进 Transformer 计算的一串数字。