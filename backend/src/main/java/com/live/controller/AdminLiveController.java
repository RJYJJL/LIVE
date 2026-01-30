package com.live.controller;

import com.live.common.Result;
import com.live.service.MockDataService;
import com.live.websocket.LiveWebSocketHandler;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.HashMap;
import java.util.Map;

/**
 * 直播控制：开始/停止直播、更新/重置投票、观看人数、广播
 */
@RestController
@RequestMapping("/api/v1/admin")
@RequiredArgsConstructor
public class AdminLiveController {

    private final MockDataService mock;

    @PostMapping("/live/start")
    public Result<Map<String, Object>> startLive(@RequestBody Map<String, Object> body) {
        String streamId = (String) body.get("streamId");
        if (streamId == null || streamId.isBlank()) return Result.fail("streamId 必填");
        mock.setLive(streamId, true);
        Map<String, Object> data = new HashMap<>();
        data.put("streamId", streamId);
        data.put("isLive", true);
        data.put("message", "直播已开始");
        LiveWebSocketHandler.broadcast("liveStatus", Map.of("streamId", streamId, "isLive", true));
        return Result.ok(data);
    }

    @PostMapping("/live/stop")
    public Result<Map<String, Object>> stopLive(@RequestBody Map<String, Object> body) {
        String streamId = (String) body.get("streamId");
        if (streamId == null || streamId.isBlank()) return Result.fail("streamId 必填");
        mock.setLive(streamId, false);
        Map<String, Object> data = new HashMap<>();
        data.put("streamId", streamId);
        data.put("isLive", false);
        data.put("message", "直播已停止");
        LiveWebSocketHandler.broadcast("liveStatus", Map.of("streamId", streamId, "isLive", false));
        return Result.ok(data);
    }

    @PostMapping("/live/update-votes")
    public Result<Map<String, Object>> updateVotes(@RequestBody Map<String, Object> body) {
        String action = (String) body.get("action");
        int left = getInt(body, "leftVotes", 0);
        int right = getInt(body, "rightVotes", 0);
        String streamId = (String) body.get("streamId");
        if (streamId == null) streamId = mock.getStreams().isEmpty() ? null : mock.getStreams().get(0).getId();
        if (streamId == null) return Result.fail("streamId 必填");
        MockDataService.VoteState v = mock.getVotes(streamId);
        if ("add".equals(action)) {
            v = new MockDataService.VoteState(v.getLeftVotes() + left, v.getRightVotes() + right);
        } else if ("reset".equals(action)) {
            v = new MockDataService.VoteState(left, right);
        } else {
            v = new MockDataService.VoteState(left, right);
        }
        mock.setVotes(streamId, v.getLeftVotes(), v.getRightVotes());
        Map<String, Object> data = new HashMap<>();
        data.put("leftVotes", v.getLeftVotes());
        data.put("rightVotes", v.getRightVotes());
        data.put("streamId", streamId);
        LiveWebSocketHandler.broadcast("votes-updated", data);
        LiveWebSocketHandler.broadcast("votesUpdate", data);
        return Result.ok(data);
    }

    @PostMapping("/live/reset-votes")
    public Result<Map<String, Object>> resetVotes(@RequestBody Map<String, Object> body) {
        Map<?, ?> resetTo = (Map<?, ?>) body.get("resetTo");
        int left = 0, right = 0;
        if (resetTo != null) {
            left = getInt(resetTo, "leftVotes", 0);
            right = getInt(resetTo, "rightVotes", 0);
        }
        String streamId = (String) body.get("streamId");
        if (streamId == null) streamId = mock.getStreams().isEmpty() ? null : mock.getStreams().get(0).getId();
        if (streamId == null) return Result.fail("streamId 必填");
        mock.setVotes(streamId, left, right);
        Map<String, Object> data = new HashMap<>();
        data.put("leftVotes", left);
        data.put("rightVotes", right);
        data.put("streamId", streamId);
        LiveWebSocketHandler.broadcast("votes-updated", data);
        LiveWebSocketHandler.broadcast("votesUpdate", data);
        return Result.ok(data);
    }

    @GetMapping("/live/viewers")
    public Result<Map<String, Object>> getViewers(@RequestParam(required = false) String stream_id) {
        if (stream_id != null) {
            int count = mock.getViewers(stream_id);
            return Result.ok(Map.of("streamId", stream_id, "viewers", count, "timestamp", System.currentTimeMillis()));
        }
        return Result.ok(Map.of("streams", mock.getAllViewers(), "timestamp", System.currentTimeMillis()));
    }

    @PostMapping("/live/broadcast-viewers")
    public Result<Map<String, Object>> broadcastViewers(@RequestBody Map<String, Object> body) {
        String streamId = (String) body.get("streamId");
        if (streamId == null) return Result.fail("streamId 必填");
        int count = mock.getViewers(streamId);
        Map<String, Object> data = Map.of("streamId", streamId, "viewers", count, "message", "已广播");
        return Result.ok(data);
    }

    private static int getInt(Map<?, ?> m, String key, int def) {
        Object v = m.get(key);
        if (v == null) return def;
        if (v instanceof Number) return ((Number) v).intValue();
        try { return Integer.parseInt(v.toString()); } catch (Exception e) { return def; }
    }
}
