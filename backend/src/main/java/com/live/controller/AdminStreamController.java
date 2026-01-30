package com.live.controller;

import com.live.common.Result;
import com.live.service.MockDataService;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

/**
 * 直播流管理：列表、增删改、切换启用；流关联辩题
 */
@RestController
@RequiredArgsConstructor
public class AdminStreamController {

    private final MockDataService mock;

    @GetMapping("/api/v1/admin/streams")
    public Result<List<MockDataService.StreamInfo>> listStreams() {
        List<MockDataService.StreamInfo> list = mock.getStreams();
        return Result.ok(list);
    }

    @PostMapping("/api/v1/admin/streams")
    public Result<MockDataService.StreamInfo> addStream(@RequestBody Map<String, Object> body) {
        String id = body.containsKey("id") ? (String) body.get("id") : "stream-" + System.currentTimeMillis();
        String name = (String) body.getOrDefault("name", "新直播流");
        boolean enabled = body.containsKey("enabled") ? Boolean.TRUE.equals(body.get("enabled")) : true;
        // 兼容表单字段：url -> pushUrl，type 用于区分
        String pushUrl = (String) body.get("pushUrl");
        if (pushUrl == null) pushUrl = (String) body.get("url");
        String playUrl = (String) body.get("playUrl");
        MockDataService.StreamInfo s = new MockDataService.StreamInfo(id, name, enabled, pushUrl, playUrl);
        mock.addStream(s);
        return Result.ok(s);
    }

    @PutMapping("/api/admin/streams/{streamId}")
    public Result<MockDataService.StreamInfo> updateStream(@PathVariable String streamId, @RequestBody Map<String, Object> body) {
        MockDataService.StreamInfo s = mock.updateStream(streamId, body);
        return s != null ? Result.ok(s) : Result.fail("流不存在");
    }

    @DeleteMapping("/api/admin/streams/{streamId}")
    public Result<Map<String, Object>> deleteStream(@PathVariable String streamId) {
        mock.deleteStream(streamId);
        return Result.ok(Map.of("streamId", streamId, "deleted", true));
    }

    @PostMapping("/api/admin/streams/{streamId}/toggle")
    public Result<MockDataService.StreamInfo> toggleStream(@PathVariable String streamId) {
        MockDataService.StreamInfo s = mock.toggleStream(streamId);
        return s != null ? Result.ok(s) : Result.fail("流不存在");
    }

    @GetMapping("/api/v1/admin/streams/{streamId}/debate")
    public Result<MockDataService.DebateDto> getStreamDebate(@PathVariable String streamId) {
        MockDataService.DebateDto d = mock.getStreamDebate(streamId);
        return Result.ok(d);
    }

    @PutMapping("/api/v1/admin/streams/{streamId}/debate")
    public Result<Map<String, Object>> setStreamDebate(@PathVariable String streamId, @RequestBody Map<String, Object> body) {
        String debateId = (String) body.get("debate_id");
        if (debateId != null) mock.associateStreamDebate(streamId, debateId);
        return Result.ok(Map.of("streamId", streamId, "debateId", debateId));
    }

    @DeleteMapping("/api/v1/admin/streams/{streamId}/debate")
    public Result<Map<String, Object>> removeStreamDebate(@PathVariable String streamId) {
        mock.removeStreamDebate(streamId);
        return Result.ok(Map.of("streamId", streamId, "removed", true));
    }
}
