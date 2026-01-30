package com.live.controller;

import com.live.common.Result;
import com.live.service.MockDataService;
import com.live.websocket.LiveWebSocketHandler;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.HashMap;
import java.util.Map;

/**
 * 小程序端接口：投票、辩题、AI 内容、投票统计等
 */
@RestController
@RequiredArgsConstructor
public class MiniprogramController {

    private final MockDataService mock;

    /** POST /api/v1/user-vote 用户投票 */
    @PostMapping("/api/v1/user-vote")
    public Result<Map<String, Object>> userVote(@RequestBody Map<String, Object> body) {
        Map<?, ?> request = body.containsKey("request") ? (Map<?, ?>) body.get("request") : body;
        int left = getInt(request, "leftVotes", 0);
        int right = getInt(request, "rightVotes", 0);
        String streamId = getStr(request, "streamId");
        if (streamId == null) streamId = getStr(request, "stream_id");
        if (streamId == null && !mock.getStreams().isEmpty()) streamId = mock.getStreams().get(0).getId();
        if (streamId != null) {
            mock.setVotes(streamId, left, right);
            Map<String, Object> data = Map.of("leftVotes", left, "rightVotes", right, "streamId", streamId);
            LiveWebSocketHandler.broadcast("votes-updated", data);
            LiveWebSocketHandler.broadcast("votesUpdate", data);
        }
        return Result.ok(Map.of("success", true, "leftVotes", left, "rightVotes", right));
    }

    /** GET /api/v1/votes?stream_id= 获取票数 */
    @GetMapping("/api/v1/votes")
    public Result<Map<String, Object>> getVotes(@RequestParam(required = false) String stream_id) {
        String sid = stream_id != null ? stream_id : (mock.getStreams().isEmpty() ? null : mock.getStreams().get(0).getId());
        if (sid == null) return Result.ok(Map.of("leftVotes", 0, "rightVotes", 0));
        MockDataService.VoteState v = mock.getVotes(sid);
        return Result.ok(Map.of("leftVotes", v.getLeftVotes(), "rightVotes", v.getRightVotes(), "streamId", sid));
    }

    /** GET /api/v1/debate-topic?stream_id= 辩题 */
    @GetMapping("/api/v1/debate-topic")
    public Result<MockDataService.DebateDto> getDebateTopic(@RequestParam(required = false) String stream_id) {
        String sid = stream_id != null ? stream_id : (mock.getStreams().isEmpty() ? null : mock.getStreams().get(0).getId());
        if (sid == null) return Result.ok(null);
        MockDataService.DebateDto d = mock.getStreamDebate(sid);
        return Result.ok(d);
    }

    /** GET /api/v1/ai-content?stream_id= AI 内容列表 */
    @GetMapping("/api/v1/ai-content")
    public Result<Map<String, Object>> getAIContent(@RequestParam(required = false) String stream_id) {
        String sid = stream_id;
        var list = mock.getAIContents(1, 50, sid);
        return Result.ok(Map.of("list", list, "total", list.size()));
    }

    /** GET /api/v1/admin/votes/statistics 投票统计（带 stream_id 可选） */
    @GetMapping("/api/v1/admin/votes/statistics")
    public Result<Map<String, Object>> votesStats(@RequestParam(required = false) String stream_id) {
        int totalLeft = 0, totalRight = 0;
        for (String sid : mock.getStreams().stream().map(MockDataService.StreamInfo::getId).toList()) {
            if (stream_id != null && !stream_id.equals(sid)) continue;
            MockDataService.VoteState v = mock.getVotes(sid);
            totalLeft += v.getLeftVotes();
            totalRight += v.getRightVotes();
        }
        Map<String, Object> data = new HashMap<>();
        data.put("totalLeftVotes", totalLeft);
        data.put("totalRightVotes", totalRight);
        data.put("totalVotes", totalLeft + totalRight);
        return Result.ok(data);
    }

    private static int getInt(Map<?, ?> m, String key, int def) {
        if (m == null) return def;
        Object v = m.get(key);
        if (v == null) return def;
        if (v instanceof Number) return ((Number) v).intValue();
        try { return Integer.parseInt(v.toString()); } catch (Exception e) { return def; }
    }

    private static String getStr(Map<?, ?> m, String key) {
        if (m == null) return null;
        Object v = m.get(key);
        return v != null ? v.toString() : null;
    }
}
