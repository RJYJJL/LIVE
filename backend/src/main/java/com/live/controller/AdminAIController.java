package com.live.controller;

import com.live.common.Result;
import com.live.service.MockDataService;
import com.live.websocket.LiveWebSocketHandler;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * AI 控制：启动/停止/切换；AI 内容列表、评论、删除
 */
@RestController
@RequiredArgsConstructor
public class AdminAIController {

    private final MockDataService mock;

    @PostMapping("/api/v1/admin/ai/start")
    public Result<Map<String, Object>> startAI(@RequestBody Map<String, Object> body) {
        String streamId = (String) body.get("streamId");
        if (streamId == null) streamId = mock.getStreams().isEmpty() ? null : mock.getStreams().get(0).getId();
        if (streamId != null) mock.setAiStatus(streamId, "running");
        Map<String, Object> data = new HashMap<>();
        data.put("status", "running");
        data.put("streamId", streamId);
        LiveWebSocketHandler.broadcast("aiStatus", data);
        return Result.ok(data);
    }

    @PostMapping("/api/v1/admin/ai/stop")
    public Result<Map<String, Object>> stopAI(@RequestBody Map<String, Object> body) {
        String streamId = (String) body.get("streamId");
        if (streamId != null) mock.setAiStatus(streamId, "stopped");
        else mock.getStreams().forEach(s -> mock.setAiStatus(s.getId(), "stopped"));
        Map<String, Object> data = Map.of("status", "stopped", "streamId", streamId != null ? streamId : "");
        LiveWebSocketHandler.broadcast("aiStatus", data);
        return Result.ok(data);
    }

    @PostMapping("/api/v1/admin/ai/toggle")
    public Result<Map<String, Object>> toggleAI(@RequestBody Map<String, Object> body) {
        String action = (String) body.get("action");
        String status = "pause".equals(action) ? "paused" : "running";
        mock.getStreams().forEach(s -> mock.setAiStatus(s.getId(), status));
        Map<String, Object> data = Map.of("status", status, "action", action);
        LiveWebSocketHandler.broadcast("aiStatus", data);
        return Result.ok(data);
    }

    @GetMapping("/api/v1/admin/ai-content/list")
    public Result<Map<String, Object>> listAIContent(
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "20") int pageSize,
            @RequestParam(required = false) String stream_id) {
        int total = mock.getAIContentsTotal(stream_id);
        var list = mock.getAIContents(page, pageSize, stream_id);
        Map<String, Object> data = new HashMap<>();
        data.put("list", list);
        data.put("total", total);
        data.put("page", page);
        data.put("pageSize", pageSize);
        return Result.ok(data);
    }

    @GetMapping("/api/v1/admin/ai-content/{contentId}/comments")
    public Result<Map<String, Object>> getComments(
            @PathVariable String contentId,
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "20") int pageSize) {
        var comments = mock.getAIContentComments(contentId, page, pageSize);
        Map<String, Object> content = mock.getAIContent(contentId);
        int total = content == null ? 0 : ((java.util.List<?>) content.getOrDefault("comments", List.of())).size();
        return Result.ok(Map.of(
                "contentId", contentId,
                "contentText", content != null ? content.get("contentText") : "",
                "comments", comments,
                "total", total,
                "page", page,
                "pageSize", pageSize
        ));
    }

    @DeleteMapping("/api/v1/admin/ai-content/{contentId}/comments/{commentId}")
    public Result<Map<String, Object>> deleteComment(
            @PathVariable String contentId,
            @PathVariable String commentId,
            @RequestBody(required = false) Map<String, Object> body) {
        return Result.ok(Map.of("contentId", contentId, "commentId", commentId, "deleted", true));
    }

    @DeleteMapping("/api/admin/ai/content/{contentId}")
    public Result<Map<String, Object>> deleteAIContent(
            @PathVariable String contentId,
            @RequestBody(required = false) Map<String, Object> body) {
        mock.deleteAIContent(contentId);
        return Result.ok(Map.of("contentId", contentId, "deleted", true));
    }
}
