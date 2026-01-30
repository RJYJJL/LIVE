package com.live.service;

import lombok.Data;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import jakarta.annotation.PostConstruct;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Mock 数据服务：内存状态，支持直播状态、投票、流、用户、辩题、AI 内容、辩论流程等
 */
@Slf4j
@Service
public class MockDataService {

    /** 直播流列表 streamId -> StreamInfo */
    private final Map<String, StreamInfo> streams = new ConcurrentHashMap<>();
    /** 每流直播状态 streamId -> isLive */
    private final Map<String, Boolean> liveStatus = new ConcurrentHashMap<>();
    /** 每流投票 streamId -> VoteState */
    private final Map<String, VoteState> votes = new ConcurrentHashMap<>();
    /** 每流 AI 状态 streamId -> running|stopped|paused */
    private final Map<String, String> aiStatus = new ConcurrentHashMap<>();
    /** 用户列表 */
    private final List<Map<String, Object>> users = new ArrayList<>();
    /** 辩题列表 debateId -> Debate */
    private final Map<String, DebateDto> debates = new ConcurrentHashMap<>();
    /** 流关联辩题 streamId -> debateId */
    private final Map<String, String> streamDebate = new ConcurrentHashMap<>();
    /** AI 内容列表 */
    private final List<Map<String, Object>> aiContents = new ArrayList<>();
    private final AtomicInteger aiContentId = new AtomicInteger(1);
    /** 辩论流程 streamId -> segments */
    private final Map<String, List<Map<String, Object>>> debateFlow = new ConcurrentHashMap<>();
    /** 每流观看人数 */
    private final Map<String, Integer> viewers = new ConcurrentHashMap<>();

    @PostConstruct
    public void init() {
        // 默认一个直播流
        String stream1 = "stream-1";
        streams.put(stream1, new StreamInfo(stream1, "默认直播流", true, "rtmp://localhost/live/stream1", null));
        liveStatus.put(stream1, false);
        votes.put(stream1, new VoteState(0, 0));
        aiStatus.put(stream1, "stopped");
        viewers.put(stream1, 0);

        String debateId = "debate-1";
        debates.put(debateId, new DebateDto(debateId, "如果有一个能一键消除痛苦的按钮，你会按吗？",
                "这是一个关于痛苦、成长与人性选择的深度辩论", "会按", "不会按", true));
        streamDebate.put(stream1, debateId);

        users.add(Map.of(
                "id", "owaF-13Ueukqwd_EFJqS-jDTI9-U",
                "nickName", "微信用户",
                "avatarUrl", "https://thirdwx.qlogo.cn/mmopen/vi_32/POgEwh4mIHO4nibH0KlMECNjjGxQUq24ZEaGT4poC6icRiccVGKSyXwibcPq4BWmiaIGuG1icwxaQX6grC9VemZoJ8rg/132",
                "createdAt", "2025-11-17T07:06:24.322Z",
                "updatedAt", "2025-11-17T07:06:24.324Z",
                "totalVotes", 0,
                "joinedDebates", 0,
                "status", "active"
        ));

        // 默认辩论流程
        debateFlow.put(stream1, List.of(
                Map.<String, Object>of("name", "正方发言", "duration", 180, "side", "left"),
                Map.<String, Object>of("name", "反方质问", "duration", 120, "side", "right"),
                Map.<String, Object>of("name", "反方发言", "duration", 180, "side", "right"),
                Map.<String, Object>of("name", "正方质问", "duration", 120, "side", "left"),
                Map.<String, Object>of("name", "自由辩论", "duration", 300, "side", "both"),
                Map.<String, Object>of("name", "正方总结", "duration", 120, "side", "left"),
                Map.<String, Object>of("name", "反方总结", "duration", 120, "side", "right")
        ));

        addMockAIContent("这是一段 AI 识别的示例内容", stream1);
        log.info("Mock 数据初始化完成: streams={}, debates={}, users={}", streams.size(), debates.size(), users.size());
    }

    private void addMockAIContent(String text, String streamId) {
        String id = "ai-" + aiContentId.getAndIncrement();
        Map<String, Object> c = new HashMap<>();
        c.put("id", id);
        c.put("contentText", text);
        c.put("streamId", streamId);
        c.put("createdAt", java.time.Instant.now().toString());
        c.put("comments", new ArrayList<Map<String, Object>>());
        aiContents.add(c);
    }

    // ---------- Streams ----------
    public List<StreamInfo> getStreams() {
        return new ArrayList<>(streams.values());
    }

    public StreamInfo getStream(String streamId) {
        return streams.get(streamId);
    }

    public StreamInfo addStream(StreamInfo s) {
        streams.put(s.getId(), s);
        liveStatus.putIfAbsent(s.getId(), false);
        votes.putIfAbsent(s.getId(), new VoteState(0, 0));
        aiStatus.putIfAbsent(s.getId(), "stopped");
        viewers.putIfAbsent(s.getId(), 0);
        return s;
    }

    public StreamInfo updateStream(String streamId, Map<String, Object> updates) {
        StreamInfo s = streams.get(streamId);
        if (s == null) return null;
        if (updates.containsKey("name")) s.setName((String) updates.get("name"));
        if (updates.containsKey("enabled")) s.setEnabled((Boolean) updates.get("enabled"));
        if (updates.containsKey("pushUrl")) s.setPushUrl((String) updates.get("pushUrl"));
        return s;
    }

    public void deleteStream(String streamId) {
        streams.remove(streamId);
        liveStatus.remove(streamId);
        votes.remove(streamId);
        aiStatus.remove(streamId);
        streamDebate.remove(streamId);
        debateFlow.remove(streamId);
        viewers.remove(streamId);
    }

    public StreamInfo toggleStream(String streamId) {
        StreamInfo s = streams.get(streamId);
        if (s != null) s.setEnabled(!s.isEnabled());
        return s;
    }

    // ---------- Live ----------
    public boolean isLive(String streamId) {
        return Boolean.TRUE.equals(liveStatus.get(streamId));
    }

    public void setLive(String streamId, boolean live) {
        liveStatus.put(streamId, live);
    }

    public String getAiStatus(String streamId) {
        return aiStatus.getOrDefault(streamId, "stopped");
    }

    public void setAiStatus(String streamId, String status) {
        aiStatus.put(streamId, status);
    }

    // ---------- Votes ----------
    public VoteState getVotes(String streamId) {
        return votes.getOrDefault(streamId, new VoteState(0, 0));
    }

    public void setVotes(String streamId, int left, int right) {
        votes.put(streamId, new VoteState(left, right));
    }

    // ---------- Viewers ----------
    public int getViewers(String streamId) {
        return viewers.getOrDefault(streamId, 0);
    }

    public Map<String, Integer> getAllViewers() {
        return new HashMap<>(viewers);
    }

    public void setViewers(String streamId, int count) {
        viewers.put(streamId, count);
    }

    // ---------- Users ----------
    public List<Map<String, Object>> getUsers(int page, int pageSize) {
        int from = (page - 1) * pageSize;
        int to = Math.min(from + pageSize, users.size());
        if (from >= users.size()) return List.of();
        return new ArrayList<>(users.subList(from, to));
    }

    public int getUsersTotal() {
        return users.size();
    }

    // ---------- Debate ----------
    public DebateDto getDebate(String debateId) {
        return debates.get(debateId);
    }

    public DebateDto getStreamDebate(String streamId) {
        String did = streamDebate.get(streamId);
        return did != null ? debates.get(did) : null;
    }

    public List<DebateDto> getDebates() {
        return new ArrayList<>(debates.values());
    }

    public DebateDto createDebate(DebateDto d) {
        debates.put(d.getId(), d);
        return d;
    }

    public DebateDto updateDebate(String debateId, DebateDto d) {
        debates.put(debateId, d);
        return d;
    }

    public void associateStreamDebate(String streamId, String debateId) {
        streamDebate.put(streamId, debateId);
    }

    public void removeStreamDebate(String streamId) {
        streamDebate.remove(streamId);
    }

    // ---------- AI Content ----------
    public List<Map<String, Object>> getAIContents(int page, int pageSize, String streamId) {
        List<Map<String, Object>> list = streamId == null ? new ArrayList<>(aiContents)
                : aiContents.stream().filter(c -> streamId.equals(c.get("streamId"))).toList();
        int from = (page - 1) * pageSize;
        int to = Math.min(from + pageSize, list.size());
        if (from >= list.size()) return List.of();
        return new ArrayList<>(list.subList(from, to));
    }

    public int getAIContentsTotal(String streamId) {
        if (streamId == null) return aiContents.size();
        return (int) aiContents.stream().filter(c -> streamId.equals(c.get("streamId"))).count();
    }

    public Map<String, Object> getAIContent(String contentId) {
        return aiContents.stream().filter(c -> contentId.equals(c.get("id"))).findFirst().orElse(null);
    }

    public List<Map<String, Object>> getAIContentComments(String contentId, int page, int pageSize) {
        Map<String, Object> content = getAIContent(contentId);
        if (content == null) return List.of();
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> comments = (List<Map<String, Object>>) content.getOrDefault("comments", List.of());
        int from = (page - 1) * pageSize;
        int to = Math.min(from + pageSize, comments.size());
        if (from >= comments.size()) return List.of();
        return new ArrayList<>(comments.subList(from, to));
    }

    public void deleteAIContent(String contentId) {
        aiContents.removeIf(c -> contentId.equals(c.get("id")));
    }

    public void addAIContent(Map<String, Object> content) {
        aiContents.add(0, content);
    }

    // ---------- Debate Flow ----------
    public List<Map<String, Object>> getDebateFlow(String streamId) {
        return debateFlow.getOrDefault(streamId, List.of());
    }

    public void setDebateFlow(String streamId, List<Map<String, Object>> segments) {
        debateFlow.put(streamId, segments);
    }

    @Data
    public static class StreamInfo {
        private String id;
        private String name;
        private boolean enabled;
        private String pushUrl;
        private String playUrl;
        public StreamInfo() {}
        public StreamInfo(String id, String name, boolean enabled, String pushUrl, String playUrl) {
            this.id = id;
            this.name = name;
            this.enabled = enabled;
            this.pushUrl = pushUrl;
            this.playUrl = playUrl;
        }
        /** 前端兼容：列表用 url 显示 */
        public String getUrl() { return pushUrl != null ? pushUrl : playUrl; }
        /** 前端兼容：根据地址推断 type */
        public String getType() { return (pushUrl != null && pushUrl.contains("rtmp")) ? "rtmp" : "hls"; }
    }

    @Data
    public static class VoteState {
        private int leftVotes;
        private int rightVotes;
        public VoteState() { this(0, 0); }
        public VoteState(int leftVotes, int rightVotes) {
            this.leftVotes = leftVotes;
            this.rightVotes = rightVotes;
        }
    }

    @Data
    public static class DebateDto {
        private String id;
        private String title;
        private String description;
        private String leftPosition;
        private String rightPosition;
        private boolean active;
        public DebateDto() {}
        public DebateDto(String id, String title, String description, String leftPosition, String rightPosition, boolean active) {
            this.id = id;
            this.title = title;
            this.description = description;
            this.leftPosition = leftPosition;
            this.rightPosition = rightPosition;
            this.active = active;
        }
    }
}
