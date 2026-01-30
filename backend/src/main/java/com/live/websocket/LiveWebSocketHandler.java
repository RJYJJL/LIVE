package com.live.websocket;

import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import java.io.IOException;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * WebSocket 实时通信：liveStatus, votes-updated, aiStatus, newAIContent, debate-updated, connected
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class LiveWebSocketHandler extends TextWebSocketHandler {

    private static final Map<String, WebSocketSession> SESSIONS = new ConcurrentHashMap<>();
    private final ObjectMapper objectMapper;

    @Override
    public void afterConnectionEstablished(WebSocketSession session) throws Exception {
        SESSIONS.put(session.getId(), session);
        log.info("WebSocket 连接: {}", session.getId());
        sendMessage(session, "connected", Map.of(
                "message", "连接成功",
                "sessionId", session.getId()
        ));
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) throws Exception {
        log.debug("收到消息: {}", message.getPayload());
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        SESSIONS.remove(session.getId());
        log.info("WebSocket 断开: {}", session.getId());
    }

    /** 向所有客户端广播 */
    public static void broadcast(String type, Object data) {
        String payload = toJson(type, data);
        SESSIONS.values().forEach(session -> {
            try {
                if (session.isOpen()) {
                    session.sendMessage(new TextMessage(payload));
                }
            } catch (IOException e) {
                log.warn("广播失败: {}", e.getMessage());
            }
        });
    }

    private static void sendMessage(WebSocketSession session, String type, Object data) throws IOException {
        session.sendMessage(new TextMessage(toJson(type, data)));
    }

    private static String toJson(String type, Object data) {
        try {
            return new ObjectMapper().writeValueAsString(Map.of("type", type, "data", data != null ? data : Map.of()));
        } catch (Exception e) {
            return "{\"type\":\"" + type + "\",\"data\":{}}";
        }
    }
}
