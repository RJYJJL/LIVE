package com.live.config;

import com.live.websocket.LiveWebSocketHandler;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;

/**
 * WebSocket 配置：/ws 端点
 * 消息类型：liveStatus, votes-updated, aiStatus, newAIContent, debate-updated, connected
 */
@Configuration
@EnableWebSocket
public class WebSocketConfig implements WebSocketConfigurer {

    private final LiveWebSocketHandler liveWebSocketHandler;

    public WebSocketConfig(LiveWebSocketHandler liveWebSocketHandler) {
        this.liveWebSocketHandler = liveWebSocketHandler;
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(liveWebSocketHandler, "/ws")
                .setAllowedOrigins("*");
    }
}
